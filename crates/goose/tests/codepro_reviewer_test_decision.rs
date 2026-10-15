use goose::agents::agent_role::{AgentRole, CodeProRiskTier};
use goose::agents::reviewer_test_decision::{
    decide_reviewer_tests, ReviewerTestDecisionInput, ReviewerTestLevel,
};
use goose::agents::task_dag::{TaskDAG, TaskNode, TaskStatus};

fn task(id: &str, role: AgentRole) -> TaskNode {
    TaskNode {
        id: id.to_string(),
        name: id.to_string(),
        description: "independent acceptance".to_string(),
        role,
        depends_on: vec![],
        acceptance_criteria: "record the selected evidence and actual result".to_string(),
        status: TaskStatus::Pending,
        output: None,
        retry_count: 0,
    }
}

#[test]
fn reviewer_decision_is_first_class_serialized_run_state() {
    let mut dag = TaskDAG::new(
        "accept visible behavior",
        vec![task("review", AgentRole::Reviewer)],
    );
    let decision = decide_reviewer_tests(&ReviewerTestDecisionInput {
        changed_files: vec!["ui/desktop/src/App.tsx".to_string()],
        risk_tier: CodeProRiskTier::L2Feature,
        user_requires_real_desktop: false,
        historical_path_regression: false,
        prior_outcome_unknown: false,
        executable_artifact_available: true,
        desktop_environment_available: true,
        permission_available: true,
        current_artifact_sha256: Some("new".to_string()),
        accepted_artifact_sha256: Some("old".to_string()),
        acceptance_environment_fingerprint: Some("vm-a".to_string()),
        current_environment_fingerprint: Some("vm-a".to_string()),
    });
    assert_eq!(decision.decision, ReviewerTestLevel::DesktopSmoke);
    dag.record_reviewer_test_decision("review", decision.clone())
        .unwrap();

    let json = serde_json::to_value(&dag).unwrap();
    assert_eq!(
        json["reviewer_test_decisions"]["review"]["decision"],
        "DESKTOP_SMOKE"
    );
    assert_eq!(
        json["reviewer_test_decisions"]["review"]["reason"],
        decision.reason
    );
    assert!(
        json["reviewer_test_decisions"]["review"]["required_evidence"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
}

#[test]
fn non_reviewer_cannot_forge_reviewer_test_decision_state() {
    let mut dag = TaskDAG::new("test", vec![task("coder", AgentRole::Coder)]);
    let decision = decide_reviewer_tests(&ReviewerTestDecisionInput {
        changed_files: vec!["src/lib.rs".to_string()],
        risk_tier: CodeProRiskTier::L1ReversibleChange,
        user_requires_real_desktop: false,
        historical_path_regression: false,
        prior_outcome_unknown: false,
        executable_artifact_available: true,
        desktop_environment_available: true,
        permission_available: true,
        current_artifact_sha256: None,
        accepted_artifact_sha256: None,
        acceptance_environment_fingerprint: None,
        current_environment_fingerprint: None,
    });
    assert!(dag
        .record_reviewer_test_decision("coder", decision)
        .is_err());
}
