use goose::agents::protocol::{TaskDependency, TaskId, TaskState};
use goose::agents::task_graph::{
    validate_plan_revision, validate_write_ownership, GraphError, TaskGraph, WriteOwnershipClaim,
};
use goose::agents::{
    agent_role::{AgentRole, CodeProRiskTier, CodeProTaskKind},
    codepro_intent::codepro_host_role_plan,
};
use std::collections::BTreeMap;

fn task(id: &str, depends_on: &[&str]) -> TaskDependency {
    TaskDependency {
        task_id: TaskId::new(id).unwrap(),
        depends_on: depends_on
            .iter()
            .map(|dependency| TaskId::new(*dependency).unwrap())
            .collect(),
    }
}

#[test]
fn graph_returns_only_dependency_satisfied_proposed_tasks_in_stable_order() {
    let graph = TaskGraph::new(
        1,
        vec![
            task("test", &["code", "schema"]),
            task("schema", &[]),
            task("code", &["schema"]),
        ],
    )
    .unwrap();
    let mut states = BTreeMap::from([
        (TaskId::new("test").unwrap(), TaskState::Proposed),
        (TaskId::new("schema").unwrap(), TaskState::Proposed),
        (TaskId::new("code").unwrap(), TaskState::Proposed),
    ]);

    assert_eq!(
        graph.ready_task_ids(&states).unwrap(),
        vec![TaskId::new("schema").unwrap()]
    );
    states.insert(TaskId::new("schema").unwrap(), TaskState::Succeeded);
    assert_eq!(
        graph.ready_task_ids(&states).unwrap(),
        vec![TaskId::new("code").unwrap()]
    );
    states.insert(TaskId::new("code").unwrap(), TaskState::Succeeded);
    assert_eq!(
        graph.ready_task_ids(&states).unwrap(),
        vec![TaskId::new("test").unwrap()]
    );
}

#[test]
fn graph_rejects_unknown_dependencies_duplicates_and_cycles() {
    assert!(matches!(
        TaskGraph::new(1, vec![task("code", &["missing"])]),
        Err(GraphError::UnknownDependency { .. })
    ));
    assert!(matches!(
        TaskGraph::new(1, vec![task("code", &[]), task("code", &[])]),
        Err(GraphError::DuplicateTask(_))
    ));
    assert!(matches!(
        TaskGraph::new(1, vec![task("a", &["b"]), task("b", &["a"])]),
        Err(GraphError::Cycle)
    ));
    assert!(matches!(
        TaskGraph::new(1, vec![task("a", &[]), task("b", &["a", "a"])]),
        Err(GraphError::DuplicateDependency { .. })
    ));
}

#[test]
fn write_ownership_rejects_overlapping_concurrent_writers() {
    let parallel = TaskGraph::new(1, vec![task("a", &[]), task("b", &[])]).unwrap();
    let claims = vec![
        WriteOwnershipClaim::new(TaskId::new("a").unwrap(), vec!["src/auth/**".into()]),
        WriteOwnershipClaim::new(
            TaskId::new("b").unwrap(),
            vec!["SRC\\auth\\token.rs".into()],
        ),
    ];
    assert!(validate_write_ownership(&parallel, &claims).is_err());

    let ordered = TaskGraph::new(1, vec![task("a", &[]), task("b", &["a"])]).unwrap();
    assert!(validate_write_ownership(&ordered, &claims).is_ok());
}

#[test]
fn wildcard_write_ownership_is_conservatively_treated_as_its_static_prefix() {
    let graph = TaskGraph::new(1, vec![task("a", &[]), task("b", &[])]).unwrap();
    for broad_path in ["**", "src/*/generated.rs"] {
        let claims = vec![
            WriteOwnershipClaim::new(TaskId::new("a").unwrap(), vec![broad_path.to_string()]),
            WriteOwnershipClaim::new(
                TaskId::new("b").unwrap(),
                vec!["src/auth/generated.rs".into()],
            ),
        ];
        assert!(
            validate_write_ownership(&graph, &claims).is_err(),
            "{broad_path} must fail closed"
        );
    }
}

#[test]
fn plan_revisions_are_initial_one_then_monotonic() {
    assert!(validate_plan_revision(None, 1).is_ok());
    assert!(validate_plan_revision(Some(1), 2).is_ok());
    assert!(validate_plan_revision(None, 2).is_err());
    assert!(validate_plan_revision(Some(1), 3).is_err());
    assert!(validate_plan_revision(Some(2), 2).is_err());
}

#[test]
fn qualification_risk_tiers_select_the_minimum_required_role_topology() {
    let l1 = codepro_host_role_plan(
        CodeProTaskKind::SimpleChange,
        "把 src/button.js 中唯一按钮文字从 old 改成 new",
    );
    assert_eq!(l1.risk_tier, CodeProRiskTier::L1ReversibleChange);
    assert!(l1.roles.is_empty());
    assert!(!l1.review_required);

    let l2 = codepro_host_role_plan(
        CodeProTaskKind::ComplexChange,
        "实现问候路由和控制器并添加自动化测试",
    );
    assert_eq!(l2.risk_tier, CodeProRiskTier::L2Feature);
    assert_eq!(
        l2.roles,
        vec![AgentRole::Planner, AgentRole::Coder, AgentRole::Tester]
    );
    assert!(!l2.review_required);

    let l3 = codepro_host_role_plan(
        CodeProTaskKind::ComplexChange,
        "实现管理员权限开关并准备发布到远端",
    );
    assert_eq!(l3.risk_tier, CodeProRiskTier::L3HighRiskRelease);
    assert_eq!(
        l3.roles,
        vec![
            AgentRole::Planner,
            AgentRole::Coder,
            AgentRole::Tester,
            AgentRole::Reviewer,
        ]
    );
    assert!(l3.review_required);
}
