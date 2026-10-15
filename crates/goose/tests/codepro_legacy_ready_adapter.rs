use goose::agents::task_dag::{TaskDAG, TaskNode, TaskStatus};
use goose::agents::task_graph::{LegacyReadyAdapter, LegacyReadyError};
use goose::agents::AgentRole;

fn task(id: &str, depends_on: &[&str]) -> TaskNode {
    TaskNode {
        id: id.into(),
        name: id.into(),
        description: format!("execute {id}"),
        role: AgentRole::Coder,
        depends_on: depends_on.iter().map(|value| (*value).into()).collect(),
        acceptance_criteria: format!("verify {id}"),
        status: TaskStatus::Pending,
        output: None,
        retry_count: 0,
    }
}

#[test]
fn adapter_is_the_explicit_boundary_that_promotes_dependency_ready_tasks() {
    let mut dag = TaskDAG::new("ship", vec![task("code", &["design"]), task("design", &[])]);

    assert!(dag.ready_tasks().is_empty());
    assert_eq!(
        LegacyReadyAdapter::promote_ready(&mut dag).unwrap(),
        vec!["design"]
    );
    assert_eq!(dag.ready_tasks()[0].id, "design");

    dag.update_task("design", TaskStatus::Done, None, 0);
    assert_eq!(
        LegacyReadyAdapter::promote_ready(&mut dag).unwrap(),
        vec!["code"]
    );
}

#[test]
fn adapter_rejects_a_ready_task_whose_dependencies_are_not_successful() {
    let mut dependent = task("test", &["code"]);
    dependent.status = TaskStatus::Ready;
    let mut dag = TaskDAG::new("ship", vec![task("code", &[]), dependent]);

    assert!(matches!(
        LegacyReadyAdapter::promote_ready(&mut dag),
        Err(LegacyReadyError::PrematureReady { .. })
    ));
}

#[test]
fn explicit_overlapping_parallel_write_contracts_fail_closed() {
    let mut dag = TaskDAG::new("ship", vec![task("a", &[]), task("b", &[])]);
    for (task_id, contract) in &mut dag.contracts {
        contract.read_scope = vec!["src/**".into()];
        contract.write_scope = vec!["src/auth/**".into()];
        contract.behavior_scope = vec![format!("change auth for {task_id}")];
        contract.forbidden_scope = vec![".git/**".into()];
    }

    let error = LegacyReadyAdapter::promote_ready(&mut dag).unwrap_err();
    assert!(
        matches!(error, LegacyReadyError::UnsafeWriteOwnership(_)),
        "unexpected error: {error:?}"
    );
}
