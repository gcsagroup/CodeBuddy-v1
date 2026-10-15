use goose::agents::control_plane::{ConvergenceAssessment, ConvergenceBlocker, ConvergenceStatus};
use goose::agents::task_dag::{TaskDAG, TaskNode, TaskOutput, TaskStatus};
use goose::agents::{AgentRole, ResultAggregator};

fn completed_dag() -> TaskDAG {
    TaskDAG::new(
        "ship verified change",
        vec![TaskNode {
            id: "code".into(),
            name: "code".into(),
            description: "implement the change".into(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "tests pass".into(),
            status: TaskStatus::Done,
            output: Some(TaskOutput {
                patch: "diff --git a/src/lib.rs b/src/lib.rs".into(),
                change_report: "implemented".into(),
                test_results: Some("command: cargo test\nresult: passed\nexit code: 0".into()),
                files_changed: vec!["src/lib.rs".into()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        }],
    )
}

#[test]
fn blocked_convergence_marks_legacy_report_as_snapshot_not_success() {
    let dag = completed_dag();
    let assessment = ConvergenceAssessment {
        status: ConvergenceStatus::Blocked,
        ready_task_ids: vec![],
        blockers: vec![ConvergenceBlocker::MissingGoalEvidence],
    };

    let report = ResultAggregator::build_report_with_convergence(&dag, &[], &assessment);
    assert!(report.contains("控制平面最终判定：未满足完成条件"));
    assert!(report.contains("执行快照，不代表运行成功"));
}

#[test]
fn eligible_convergence_is_rendered_as_the_authoritative_completion_verdict() {
    let dag = completed_dag();
    let assessment = ConvergenceAssessment {
        status: ConvergenceStatus::Eligible,
        ready_task_ids: vec![],
        blockers: vec![],
    };

    let report = ResultAggregator::build_report_with_convergence(&dag, &[], &assessment);
    assert!(report.contains("控制平面最终判定：完成条件已满足"));
    assert!(!report.contains("执行快照，不代表运行成功"));
}

#[test]
fn high_risk_run_without_reviewer_approval_cannot_render_success() {
    let dag = completed_dag();
    let assessment = ConvergenceAssessment {
        status: ConvergenceStatus::Blocked,
        ready_task_ids: vec![],
        blockers: vec![ConvergenceBlocker::ReviewerBlockers(1)],
    };

    let report = ResultAggregator::build_report_with_convergence(&dag, &[], &assessment);

    assert!(report.contains("控制平面最终判定：未满足完成条件"));
    assert!(report.contains("执行快照，不代表运行成功"));
    assert!(!report.contains("控制平面最终判定：完成条件已满足"));
}
