use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{
    CompletionProposal, CompletionRequirements, ConvergenceBlocker, ConvergenceEngine,
    ConvergenceStatus,
};
use goose::agents::protocol::{
    EventId, EvidenceRef, ProtocolVersion, RunEvent, RunEventPayload, RunId, RunState,
    TaskDependency, TaskId, TaskResult, TaskState,
};
use goose::agents::reporting::RunProjection;
use std::collections::{BTreeMap, BTreeSet};

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("event-{sequence}")).unwrap();
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

fn projection(task_state: TaskState, result_evidence: Vec<EvidenceRef>) -> RunProjection {
    let run_id = RunId::new("run-convergence").unwrap();
    let task_id = TaskId::new("task-code").unwrap();
    let mut events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "ship a verified change".into(),
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
                name: "implement change".into(),
                role: None,
            },
        ),
        event(
            &run_id,
            4,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies: vec![TaskDependency {
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
    ];
    if task_state != TaskState::Proposed {
        events.push(event(
            &run_id,
            6,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ));
    }
    if matches!(
        task_state,
        TaskState::Running | TaskState::Paused | TaskState::Succeeded
    ) {
        events.push(event(
            &run_id,
            7,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ));
    }
    match task_state {
        TaskState::Paused => events.push(event(
            &run_id,
            8,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::Paused,
            },
        )),
        TaskState::Succeeded => events.push(event(
            &run_id,
            8,
            Some(&task_id),
            RunEventPayload::TaskSucceeded {
                task_id: task_id.clone(),
                result: TaskResult {
                    summary: "implemented and tested".into(),
                    evidence_refs: result_evidence,
                },
            },
        )),
        _ => {}
    }
    RunProjection::rebuild(&events).unwrap()
}

fn evidence(name: &str) -> EvidenceRef {
    EvidenceRef::new(
        RunId::new("run-convergence").unwrap(),
        EventId::new(format!("evidence-{name}")).unwrap(),
        format!("artifacts/{name}.txt"),
    )
    .unwrap()
}

fn complete_requirements(goal_evidence: Vec<EvidenceRef>) -> CompletionRequirements {
    CompletionRequirements {
        plan_revision: Some(1),
        goal_evidence,
        evidence_required_tasks: BTreeSet::from([TaskId::new("task-code").unwrap()]),
        reviewer_blockers: vec![],
        unresolved_high_risk_writes: vec![],
        uncertain_effects: vec![],
        ..CompletionRequirements::default()
    }
}

#[test]
fn convergence_discovers_ready_tasks_without_dispatching_them() {
    let assessment = ConvergenceEngine::assess(
        &projection(TaskState::Proposed, vec![]),
        &CompletionRequirements::default(),
    );

    assert_eq!(assessment.status, ConvergenceStatus::InProgress);
    assert_eq!(
        assessment.ready_task_ids,
        vec![TaskId::new("task-code").unwrap()]
    );
    assert!(assessment.blockers.iter().any(|blocker| matches!(
        blocker,
        ConvergenceBlocker::TaskNotSuccessful {
            state: TaskState::Proposed,
            ..
        }
    )));
}

#[test]
fn running_task_has_a_task_identified_completion_gap() {
    let assessment = ConvergenceEngine::assess(
        &projection(TaskState::Running, vec![]),
        &complete_requirements(vec![evidence("goal")]),
    );

    assert_eq!(assessment.status, ConvergenceStatus::InProgress);
    assert!(assessment.blockers.iter().any(|blocker| matches!(
        blocker,
        ConvergenceBlocker::TaskNotSuccessful {
            task_id,
            state: TaskState::Running,
        } if task_id.as_str() == "task-code"
    )));
}

#[test]
fn success_requires_goal_task_and_report_evidence_with_no_open_risks() {
    let task_evidence = evidence("test");
    let projection = projection(TaskState::Succeeded, vec![task_evidence.clone()]);
    let missing_goal = ConvergenceEngine::assess(&projection, &complete_requirements(vec![]));
    assert_eq!(missing_goal.status, ConvergenceStatus::Blocked);
    assert!(missing_goal
        .blockers
        .contains(&ConvergenceBlocker::MissingGoalEvidence));

    let mut requirements = complete_requirements(vec![task_evidence]);
    requirements.uncertain_effects.push("tool-write-7".into());
    assert_eq!(
        ConvergenceEngine::assess(&projection, &requirements).status,
        ConvergenceStatus::Blocked
    );

    requirements.uncertain_effects.clear();
    assert_eq!(
        ConvergenceEngine::assess(&projection, &requirements).status,
        ConvergenceStatus::Eligible
    );
}

#[test]
fn action_limited_paused_task_never_counts_as_success() {
    let assessment = ConvergenceEngine::assess(
        &projection(TaskState::Paused, vec![]),
        &complete_requirements(vec![evidence("goal")]),
    );

    assert_eq!(assessment.status, ConvergenceStatus::Blocked);
    assert!(assessment.blockers.iter().any(|blocker| matches!(
        blocker,
        ConvergenceBlocker::TaskNotSuccessful {
            state: TaskState::Paused,
            ..
        }
    )));
}

#[test]
fn reviewer_approval_does_not_replace_execution_evidence() {
    let task_evidence = evidence("test");
    let projection = projection(TaskState::Succeeded, vec![task_evidence.clone()]);
    let mut requirements = complete_requirements(vec![task_evidence]);
    requirements
        .reviewer_blockers
        .push("review:blocking-1".into());

    let assessment = ConvergenceEngine::assess(&projection, &requirements);
    assert_eq!(assessment.status, ConvergenceStatus::Blocked);
    assert!(assessment
        .blockers
        .contains(&ConvergenceBlocker::ReviewerBlockers(1)));
    requirements.reviewer_blockers.clear();
    assert_eq!(
        ConvergenceEngine::assess(&projection, &requirements).status,
        ConvergenceStatus::Eligible
    );
    requirements.goal_evidence.clear();
    assert!(ConvergenceEngine::assess(&projection, &requirements)
        .blockers
        .contains(&ConvergenceBlocker::MissingGoalEvidence));
}

#[test]
fn main_agent_completion_must_cover_the_committed_requirement_revision() {
    let committed = evidence("requirement");
    let mut projection = projection(TaskState::Succeeded, vec![committed.clone()]);
    projection.user_requirement_revision = 1;
    projection.user_requirements = ["root-goal", "report-result"]
        .into_iter()
        .map(|id| {
            (
                id.to_string(),
                goose::agents::protocol::UserRequirement {
                    requirement_id: id.to_string(),
                    source_message_id: "message-1".to_string(),
                    continuation_source: None,
                    semantics: Some(goose::agents::protocol::RequirementSemantics {
                        content: format!("Deliver {id}"),
                        expected_effect: Some(
                            goose::agents::protocol::RequirementEffect::Observation,
                        ),
                        target_resources: vec!["workspace".to_string()],
                        revision_relation: None,
                    }),
                    execution_obligations: Vec::new(),
                },
            )
        })
        .collect();
    let proposal = CompletionProposal::for_main_agent_with_coverage(
        &projection,
        TaskId::new("task-code").unwrap(),
        ["root-goal", "report-result"]
            .into_iter()
            .map(
                |id| goose::agents::control_plane::RequirementEvidenceCoverage {
                    requirement_id: id.to_string(),
                    evidence_refs: vec![committed.clone()],
                    audit_ids: vec![format!("audit-{id}")],
                    resource_versions: BTreeMap::new(),
                },
            )
            .collect(),
        Vec::new(),
    );
    let requirements = CompletionRequirements::host_derived(&projection, &proposal);
    assert_eq!(
        ConvergenceEngine::assess(&projection, &requirements).status,
        ConvergenceStatus::Eligible
    );

    let mut incomplete = proposal;
    incomplete.requirement_coverage.pop();
    let assessment = ConvergenceEngine::assess(
        &projection,
        &CompletionRequirements::host_derived(&projection, &incomplete),
    );
    assert_eq!(assessment.status, ConvergenceStatus::Blocked);
    assert!(assessment
        .blockers
        .contains(&ConvergenceBlocker::RequirementCoverageMismatch));
}
