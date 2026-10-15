use crate::agents::agent_role::AgentRole;
use crate::agents::codepro_report::{
    sanitize_report_block, sanitize_report_inline, CodeProReportClassification, CodeProReportKind,
};
use crate::agents::codepro_run_result::{CodeProRunResult, VerificationOutcome};
use crate::agents::codepro_terminal_report::ClassificationCounts;
use crate::agents::control_plane::{ConvergenceAssessment, ConvergenceStatus};
use crate::agents::finding_record::{
    classify_finding_validation, FindingLifecycle, FindingValidationDecisionReason,
    FindingValidationStatus,
};
use crate::agents::task_dag::{DagOutcome, TaskDAG, TaskNode, TaskOutput, TaskStatus};
use crate::agents::user_report::{render_user_report_v1, UserReportV1};
use std::collections::{BTreeMap, HashSet};

pub struct ResultAggregator;

#[derive(Default)]
struct ClassifiedFindings {
    confirmed: Vec<String>,
    risks: Vec<String>,
}

#[derive(Clone, Copy)]
struct TestCaseSummary {
    passed: usize,
    failed: usize,
    skipped: usize,
}

fn report_section(report: &str, heading: &str) -> String {
    let marker = format!("\n## {heading}\n\n");
    let Some(start) = report.find(&marker).map(|index| index + marker.len()) else {
        return String::new();
    };
    let tail = report
        .get(start..)
        .expect("section start comes from a matched UTF-8 marker");
    let end = tail.find("\n## ").unwrap_or(tail.len());
    tail.get(..end)
        .expect("section end comes from a matched UTF-8 marker")
        .trim()
        .to_string()
}

impl ResultAggregator {
    pub(crate) fn classification_counts(
        dag: &TaskDAG,
        task_results: &[TaskNode],
    ) -> ClassificationCounts {
        let run_result = CodeProRunResult::from_run(dag, task_results);
        let tasks_without_evidence = run_result
            .tasks
            .iter()
            .filter(|task| !task.has_current_evidence)
            .map(|task| task.id.as_str())
            .collect::<HashSet<_>>();
        let project_python_ready = Self::project_python_test_environment_ready(dag);
        let command_execution_issues = dag
            .tasks
            .iter()
            .filter(|task| {
                tasks_without_evidence.contains(task.id.as_str())
                    || Self::is_agent_execution_issue(task, project_python_ready)
            })
            .count();
        let environment_issues = dag
            .tasks
            .iter()
            .filter(|task| {
                Self::environment_issue_reason(task).is_some()
                    && !Self::environment_issue_is_resolved(task, project_python_ready)
            })
            .count();
        let test_failures = dag
            .tasks
            .iter()
            .filter(|task| {
                !Self::environment_issue_is_unresolved(task, project_python_ready)
                    && run_result.verification_groups.iter().any(|group| {
                        group.task_id == task.id
                            && matches!(
                                group.current.outcome,
                                VerificationOutcome::TestFailed | VerificationOutcome::CheckFailed
                            )
                    })
            })
            .count();
        let findings = Self::classified_findings(dag);
        let coverage_gaps = Self::coverage_gaps(dag).len();
        ClassificationCounts {
            confirmed_bug: saturating_u32(findings.confirmed.len()),
            test_failure: saturating_u32(test_failures),
            environment_problem: saturating_u32(environment_issues),
            codepro_incomplete: saturating_u32(command_execution_issues),
            unverified: saturating_u32(findings.risks.len() + coverage_gaps),
        }
    }

    pub fn build_report_with_convergence(
        dag: &TaskDAG,
        task_results: &[TaskNode],
        assessment: &ConvergenceAssessment,
    ) -> String {
        let report = Self::build_report(dag, task_results);
        let verdict = match assessment.status {
            ConvergenceStatus::Eligible if assessment.blockers.is_empty() => {
                "控制平面最终判定：完成条件已满足。".to_string()
            }
            ConvergenceStatus::InProgress => format!(
                "控制平面最终判定：运行仍在进行；当前仅为执行快照，不代表运行成功。待调度 Ready 任务：{} 项。",
                assessment.ready_task_ids.len()
            ),
            ConvergenceStatus::Blocked | ConvergenceStatus::Eligible => format!(
                "控制平面最终判定：未满足完成条件；当前仅为执行快照，不代表运行成功。未决门禁：{} 项。",
                assessment.blockers.len()
            ),
        };
        format!("> **{verdict}**\n\n{report}")
    }

    pub fn build_progress(dag: &TaskDAG, phase: &str) -> String {
        let mut progress = format!("CodePro · {phase}\n");
        let done_count = dag
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Done)
            .count();
        progress.push_str(&format!(
            "进度：{done_count} / {} 个任务已完成\n",
            dag.tasks.len()
        ));
        if let Some(task) = dag
            .tasks
            .iter()
            .find(|task| task.status == TaskStatus::Running)
        {
            progress.push_str(&format!(
                "当前任务：{} · {}\n",
                sanitize_report_inline(&task.id),
                sanitize_report_inline(&task.name)
            ));
            progress.push_str(&format!("说明：{}\n", Self::single_line(&task.description)));
            progress.push_str(&format!(
                "验收目标：{}\n",
                Self::single_line(&task.acceptance_criteria)
            ));
        } else if let Some(task) = dag.tasks.iter().rev().find(|task| task.is_terminal()) {
            let result = match task.status {
                TaskStatus::Done => "已完成",
                TaskStatus::VerificationFailed => "验证失败",
                TaskStatus::WaitingForUser => "等待用户操作",
                TaskStatus::RepairExhausted => "修复预算已耗尽",
                TaskStatus::Failed => "执行失败",
                TaskStatus::Paused => "已保存检查点",
                TaskStatus::Cancelled => "已停止",
                TaskStatus::Skipped => "已跳过",
                _ => "已更新",
            };
            progress.push_str(&format!(
                "最近结果：{} · {}{result}\n",
                sanitize_report_inline(&task.id),
                sanitize_report_inline(&task.name)
            ));
        } else if let Some(task) = dag
            .tasks
            .iter()
            .find(|task| matches!(task.status, TaskStatus::Pending | TaskStatus::Ready))
        {
            progress.push_str(&format!(
                "下一步：{} · {}\n",
                sanitize_report_inline(&task.id),
                sanitize_report_inline(&task.name)
            ));
            progress.push_str(&format!("说明：{}\n", Self::single_line(&task.description)));
        }
        progress.push_str("--- CodePro 任务快照 ---\n");
        for task in &dag.tasks {
            let icon = Self::status_icon(task.status);
            progress.push_str(&format!(
                "{icon} {}: {}\n",
                sanitize_report_inline(&task.id),
                sanitize_report_inline(&task.name)
            ));
        }
        progress
    }

    pub fn build_report(dag: &TaskDAG, task_results: &[TaskNode]) -> String {
        let run_result = CodeProRunResult::from_run(dag, task_results);
        let report_kind = dag
            .task_kind
            .and_then(CodeProReportKind::from_task_kind)
            .unwrap_or_else(|| {
                if run_result
                    .tasks
                    .iter()
                    .any(|task| task.role == AgentRole::Coder)
                    || !run_result.current_files.is_empty()
                {
                    CodeProReportKind::Fix
                } else {
                    CodeProReportKind::Test
                }
            });
        let tasks_without_evidence = run_result
            .tasks
            .iter()
            .filter(|task| !task.has_current_evidence)
            .map(|task| task.id.as_str())
            .collect::<HashSet<_>>();
        let done_count = dag
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Done)
            .count();
        let project_python_ready = Self::project_python_test_environment_ready(dag);
        let command_execution_issues = dag
            .tasks
            .iter()
            .filter(|task| {
                tasks_without_evidence.contains(task.id.as_str())
                    || Self::is_agent_execution_issue(task, project_python_ready)
            })
            .collect::<Vec<_>>();
        let paused_tasks = dag
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Paused)
            .collect::<Vec<_>>();
        let environment_issues = dag
            .tasks
            .iter()
            .filter(|task| {
                Self::environment_issue_reason(task).is_some()
                    && !Self::environment_issue_is_resolved(task, project_python_ready)
            })
            .collect::<Vec<_>>();
        let test_failures = dag
            .tasks
            .iter()
            .filter(|task| {
                !Self::environment_issue_is_unresolved(task, project_python_ready)
                    && run_result.verification_groups.iter().any(|group| {
                        group.task_id == task.id
                            && group.current.outcome == VerificationOutcome::TestFailed
                    })
            })
            .collect::<Vec<_>>();
        let quality_failures = dag
            .tasks
            .iter()
            .filter(|task| {
                !Self::environment_issue_is_unresolved(task, project_python_ready)
                    && run_result.verification_groups.iter().any(|group| {
                        group.task_id == task.id
                            && group.current.outcome == VerificationOutcome::CheckFailed
                    })
            })
            .collect::<Vec<_>>();
        let findings = Self::classified_findings(dag);
        let safe_findings = ClassifiedFindings {
            confirmed: findings
                .confirmed
                .iter()
                .map(|finding| sanitize_report_block(finding))
                .collect(),
            risks: findings
                .risks
                .iter()
                .map(|finding| sanitize_report_block(finding))
                .collect(),
        };
        let confirmed_findings = &safe_findings.confirmed;
        let risk_findings = &safe_findings.risks;
        let coverage_gaps = Self::coverage_gaps(dag)
            .into_iter()
            .map(|gap| sanitize_report_block(&gap))
            .collect::<Vec<_>>();
        let test_case_summary = Self::test_case_summary(dag);
        let verification_passed = dag
            .tasks
            .iter()
            .filter(|task| {
                let current = run_result
                    .verification_groups
                    .iter()
                    .filter(|group| group.task_id == task.id)
                    .map(|group| group.current.outcome)
                    .collect::<Vec<_>>();
                !Self::environment_issue_is_unresolved(task, project_python_ready)
                    && !current.is_empty()
                    && current.iter().all(|outcome| {
                        matches!(
                            outcome,
                            VerificationOutcome::Passed | VerificationOutcome::Completed
                        ) || (*outcome == VerificationOutcome::EnvironmentUnavailable
                            && !Self::environment_issue_is_unresolved(task, project_python_ready))
                    })
            })
            .count();

        let dag_outcome = dag.outcome();
        let overall_state = if dag_outcome == DagOutcome::Paused {
            "已保存进度"
        } else if dag_outcome == DagOutcome::Cancelled {
            "已停止"
        } else if !confirmed_findings.is_empty()
            || !risk_findings.is_empty()
            || !test_failures.is_empty()
            || !quality_failures.is_empty()
        {
            "发现问题"
        } else if dag_outcome == DagOutcome::Partial {
            "部分完成"
        } else if !command_execution_issues.is_empty() {
            "未完成"
        } else if !coverage_gaps.is_empty() {
            "没有检查完整"
        } else {
            "检查完成"
        };
        let conclusion = if let Some(paused_task) = paused_tasks.first() {
            paused_task
                .output
                .as_ref()
                .map(|output| output.change_report.as_str())
                .unwrap_or("本轮操作 Agent 行动已上限，当前进度已经保存。您可以点击重试继续执行。")
        } else if !confirmed_findings.is_empty() {
            if environment_issues.is_empty()
                && command_execution_issues.is_empty()
                && coverage_gaps.is_empty()
            {
                "已完成真实代码检查与离线测试，并发现了可定位、可核验的问题。"
            } else {
                "已完成真实代码检查与可执行的离线测试，并发现了可定位、可核验的问题。环境问题和未验证内容会单独列出，不会覆盖已经确认的结论。"
            }
        } else if !risk_findings.is_empty() {
            "已完成代码检查并发现需要进一步核对接口约定的风险。行为已经观察或复现，但在找到明确规格、类型合同或用户场景前，只能标记为未验证，不能称为确认 Bug。"
        } else if !test_failures.is_empty()
            && (!environment_issues.is_empty() || !command_execution_issues.is_empty())
        {
            "测试失败已经由当前命令证据确认；另外有检查任务没有完成。具体失败位置和未完成原因如下。"
        } else if !environment_issues.is_empty() && !command_execution_issues.is_empty() {
            "测试环境没有准备完整，同时有 CodePro 任务没有执行成功。本次没有得到完整的项目检查结果。"
        } else if !environment_issues.is_empty() {
            "已完成当前环境能够执行的检查。需要额外工具、依赖、密钥或外部服务的内容没有运行，已单独列出。"
        } else if !command_execution_issues.is_empty() {
            "CodePro 有任务没有执行完成。本次没有得到完整的项目检查结果。"
        } else if !test_failures.is_empty() {
            "测试失败已经由当前命令证据确认。具体失败测试和位置如下。"
        } else if !quality_failures.is_empty() {
            "测试失败分类中包含当前代码质量检查失败。具体文件和位置如下。"
        } else if !coverage_gaps.is_empty() {
            "已经运行的检查没有失败，但还有部分内容没有验证。"
        } else {
            "检查已完成，目前没有发现需要处理的问题。"
        };
        let conclusion = sanitize_report_block(&Self::truncate(conclusion, 500));
        if report_kind == CodeProReportKind::Test {
            let confirmed_bug = CodeProReportClassification::ConfirmedBug.label();
            let test_failure = CodeProReportClassification::TestFailure.label();
            let environment_problem = CodeProReportClassification::EnvironmentProblem.label();
            let codepro_incomplete = CodeProReportClassification::CodeProIncomplete.label();
            let unverified = CodeProReportClassification::Unverified.label();
            let mut report = String::from("# CodePro 测试报告\n\n## 结论\n\n");
            report.push_str(&conclusion);
            report.push_str(&format!(
                "\n\n- {confirmed_bug}：{} 项\n- {test_failure}：{} 项\n- {environment_problem}：{} 项\n- {codepro_incomplete}：{} 项\n- {unverified}：{} 项\n",
                confirmed_findings.len(),
                test_failures.len() + quality_failures.len(),
                environment_issues.len(),
                command_execution_issues.len(),
                risk_findings.len() + coverage_gaps.len()
            ));

            report.push_str("\n\n## 确认发现的问题\n\n");
            if confirmed_findings.is_empty()
                && test_failures.is_empty()
                && quality_failures.is_empty()
            {
                report.push_str("- 当前没有确认的问题。\n");
            } else {
                for finding in confirmed_findings {
                    report.push_str(&format!(
                        "- **{confirmed_bug}**：{finding}\n  - 下一步：修复该位置违反项目约定的行为，并重新运行原验证。\n"
                    ));
                }
                for task in &test_failures {
                    report.push_str(&format!(
                        "- **{test_failure} · {}**\n",
                        sanitize_report_inline(&task.name)
                    ));
                    let locations = Self::test_failure_locations(task);
                    if locations.is_empty() {
                        report.push_str("  - 位置：测试输出没有提供可识别的测试名称。\n");
                    } else {
                        for location in locations {
                            let location = sanitize_report_inline(&location).replace('`', "\\`");
                            report.push_str(&format!("  - 位置：`{location}`\n"));
                        }
                    }
                    if let Some(summary) = Self::failure_summary(task) {
                        let summary = sanitize_report_block(&summary);
                        report.push_str(&format!("  - 结果：{summary}\n"));
                    }
                    report.push_str("  - 下一步：修复失败位置后重新运行该测试。\n");
                }
                for task in &quality_failures {
                    report.push_str(&format!(
                        "- **{test_failure} · {}**\n",
                        sanitize_report_inline(&task.name)
                    ));
                    let locations = Self::quality_failure_locations(task);
                    if locations.is_empty() {
                        report.push_str("  - 质量工具没有提供可识别的文件位置。\n");
                    } else {
                        for location in locations {
                            let location = sanitize_report_inline(&location).replace('`', "\\`");
                            report.push_str(&format!("  - 位置：`{location}`\n"));
                        }
                    }
                    report.push_str("  - 结果：代码质量检查失败。\n");
                    report.push_str("  - 下一步：修复所列文件问题后重新运行该检查。\n");
                }
            }

            report.push_str("\n## 已通过检查\n\n");
            report.push_str(&format!(
                "- 已完成：{done_count} / {}\n- 已通过：{verification_passed} 项\n",
                dag.tasks.len()
            ));
            if let Some(summary) = test_case_summary {
                report.push_str(&format!(
                    "- 测试用例：{} 通过，{} 失败，{} 跳过\n",
                    summary.passed, summary.failed, summary.skipped
                ));
            }
            if project_python_ready {
                report.push_str("- 环境恢复：已找到项目 Python 环境并成功启动 pytest\n");
            }
            for task in &dag.tasks {
                let current = run_result
                    .verification_groups
                    .iter()
                    .filter(|group| group.task_id == task.id)
                    .map(|group| group.current.outcome)
                    .collect::<Vec<_>>();
                if !current.is_empty()
                    && current.iter().all(|outcome| {
                        matches!(
                            outcome,
                            VerificationOutcome::Passed | VerificationOutcome::Completed
                        )
                    })
                {
                    report.push_str(&format!("- {}\n", sanitize_report_inline(&task.name)));
                }
            }

            report.push_str("\n## 未完成和未验证\n\n");
            if environment_issues.is_empty()
                && command_execution_issues.is_empty()
                && coverage_gaps.is_empty()
                && paused_tasks.is_empty()
                && risk_findings.is_empty()
            {
                report.push_str("- 无。\n");
            } else {
                for task in &environment_issues {
                    report.push_str(&format!(
                        "- **{environment_problem} · {}**\n  - 位置：运行环境\n  - 原因：{}\n  - 下一步：准备缺少的运行时或依赖，然后重新运行该检查。\n",
                        sanitize_report_inline(&task.name),
                        Self::environment_issue_reason(task).unwrap_or("运行环境没有准备好")
                    ));
                }
                for task in &command_execution_issues {
                    let next_step = if task.status == TaskStatus::Paused {
                        "从已保存的检查点继续执行该任务。"
                    } else {
                        "根据原因恢复该任务，然后从未完成步骤重新执行。"
                    };
                    report.push_str(&format!(
                        "- **{codepro_incomplete} · {}**\n  - 位置：CodePro 任务 `{}`\n  - 原因：{}\n  - 下一步：{next_step}\n",
                        sanitize_report_inline(&task.name),
                        sanitize_report_inline(&task.id).replace('`', "\\`"),
                        Self::task_failure_reason(task)
                    ));
                }
                for gap in &coverage_gaps {
                    report.push_str(&format!(
                        "- **{unverified}**：{gap}\n  - 位置：未提供。\n  - 下一步：补充该范围的检查证据后重新生成报告。\n"
                    ));
                }
                for finding in risk_findings {
                    report.push_str(&format!(
                        "- **{unverified}**：{finding}\n  - 下一步：核对该位置的项目约定，并运行最小复现后再决定是否修复。\n"
                    ));
                }
            }

            report.push_str("\n## 用户下一步\n\n");
            if !confirmed_findings.is_empty()
                || !test_failures.is_empty()
                || !quality_failures.is_empty()
            {
                report.push_str("先修复上面已经确认的问题，再重新运行相关测试。\n");
            } else if !risk_findings.is_empty() {
                report.push_str("先核对待确认风险所依赖的项目约定，确认后再决定是否修复。\n");
            } else if !environment_issues.is_empty() {
                report.push_str("准备缺少的运行环境或依赖，然后重新执行未验证的检查。\n");
            } else if !command_execution_issues.is_empty()
                || !coverage_gaps.is_empty()
                || !paused_tasks.is_empty()
            {
                report.push_str("继续执行尚未完成或尚未验证的检查。\n");
            } else {
                report.push_str("当前不需要额外处理。\n");
            }

            let mut technical_details = String::new();
            Self::append_cross_run_summary(&mut technical_details, dag);
            Self::append_technical_details(&mut technical_details, &run_result, dag);
            let technical_details = technical_details
                .replace("<details>\n<summary>查看运行记录（可选）</summary>\n\n", "")
                .replace("\n</details>", "")
                .trim()
                .to_string();
            let confirmed = report_section(&report, "确认发现的问题");
            let passed = report_section(&report, "已通过检查");
            let mut cross_run_summary = String::new();
            Self::append_cross_run_summary(&mut cross_run_summary, dag);
            let cross_run_summary = cross_run_summary.trim().to_string();
            let incomplete = report_section(&report, "未完成和未验证");
            let next = report_section(&report, "用户下一步");
            let mut visible_findings = Vec::new();
            let test_failure_count = test_failures.len() + quality_failures.len();
            let incomplete_count = command_execution_issues.len();
            let unverified_count = risk_findings.len() + coverage_gaps.len();
            for (label, count) in [
                (confirmed_bug, confirmed_findings.len()),
                (test_failure, test_failure_count),
                (environment_problem, environment_issues.len()),
                (codepro_incomplete, incomplete_count),
                (unverified, unverified_count),
            ] {
                if count > 0 {
                    visible_findings.push(format!("{label}：{count} 项"));
                }
            }
            if visible_findings.is_empty() {
                visible_findings.push("没有发现需要处理的问题。".to_string());
            }
            if !confirmed.trim().is_empty() {
                visible_findings.push(confirmed);
            }
            return render_user_report_v1(&UserReportV1 {
                schema_version: 1,
                result: conclusion,
                agent_results: Vec::new(),
                changes: visible_findings,
                verification: [passed, cross_run_summary]
                    .into_iter()
                    .filter(|item| !item.trim().is_empty())
                    .collect(),
                user_actions: [incomplete, next]
                    .into_iter()
                    .filter(|item| {
                        let item = item.trim();
                        !item.is_empty() && item != "- 无。" && item != "当前不需要额外处理。"
                    })
                    .collect(),
                technical_details: (!technical_details.is_empty())
                    .then_some(technical_details)
                    .into_iter()
                    .collect(),
            });
        }

        if report_kind == CodeProReportKind::Fix {
            let confirmed_bug = CodeProReportClassification::ConfirmedBug.label();
            let test_failure = CodeProReportClassification::TestFailure.label();
            let environment_problem = CodeProReportClassification::EnvironmentProblem.label();
            let codepro_incomplete = CodeProReportClassification::CodeProIncomplete.label();
            let unverified = CodeProReportClassification::Unverified.label();
            let has_limitations = dag_outcome != DagOutcome::Passed
                || run_result.current_files.is_empty()
                || run_result.verification_groups.is_empty()
                || !confirmed_findings.is_empty()
                || !risk_findings.is_empty()
                || !test_failures.is_empty()
                || !quality_failures.is_empty()
                || !environment_issues.is_empty()
                || !command_execution_issues.is_empty()
                || !coverage_gaps.is_empty()
                || !paused_tasks.is_empty();
            let result = if !has_limitations {
                "已经修好，当前修改和验证均已完成。".to_string()
            } else if run_result.current_files.is_empty() {
                format!("{codepro_incomplete}：当前没有可确认的修改文件。")
            } else if !test_failures.is_empty() || !quality_failures.is_empty() {
                format!("{test_failure}：修改已经写入，但当前验证没有通过。")
            } else if !environment_issues.is_empty() {
                format!("{environment_problem}：修改已经写入，但当前环境不能完成验证。")
            } else if !command_execution_issues.is_empty() || !paused_tasks.is_empty() {
                format!("{codepro_incomplete}：修改已经写入，但验证任务没有执行完成。")
            } else if run_result.verification_groups.is_empty() {
                format!("{unverified}：当前修改没有验证结果，不能宣布已经修好。")
            } else {
                format!("{unverified}：仍有覆盖缺口或候选问题，不能宣布已经修好。")
            };

            let mut changes = Vec::new();
            if run_result.current_files.is_empty() {
                changes.push("没有可确认的当前修改文件。".to_string());
            } else {
                for file in run_result.current_files.iter().take(12) {
                    let file = sanitize_report_inline(file).replace('`', "\\`");
                    changes.push(format!("修改了 `{file}`。"));
                }
                if run_result.current_files.len() > 12 {
                    changes.push(format!(
                        "另有 {} 个当前修改文件，详见技术详情。",
                        run_result.current_files.len() - 12
                    ));
                }
            }

            let visible_change = run_result
                .tasks
                .iter()
                .filter(|task| task.role == AgentRole::Coder)
                .filter_map(|task| task.current_output.as_ref())
                .filter(|output| !Self::worker_change_report_conflicts_with_host(output))
                .flat_map(|output| output.change_report.lines())
                .map(str::trim)
                .find(|line| !line.is_empty());
            if let Some(change) = visible_change {
                changes.push(sanitize_report_block(&Self::truncate(change, 500)));
            } else if run_result.current_files.is_empty() {
                changes.push("本次没有产生可确认的用户可见变化。".to_string());
            } else {
                changes
                    .push("修改已经写入当前文件，执行结果没有提供额外的用户变化说明。".to_string());
            }

            let mut verification = Vec::new();
            if run_result.verification_groups.is_empty() {
                verification.push("没有当前验证结果。".to_string());
            } else {
                for group in &run_result.verification_groups {
                    let task_name = run_result
                        .tasks
                        .iter()
                        .find(|task| task.id == group.task_id)
                        .map(|task| task.name.as_str())
                        .unwrap_or(group.task_id.as_str());
                    let outcome = match group.current.outcome {
                        VerificationOutcome::Passed | VerificationOutcome::Completed => "通过",
                        VerificationOutcome::TestFailed | VerificationOutcome::CheckFailed => {
                            test_failure
                        }
                        VerificationOutcome::EnvironmentUnavailable => environment_problem,
                        VerificationOutcome::CommandFailed => codepro_incomplete,
                        VerificationOutcome::NoTests | VerificationOutcome::Unknown => unverified,
                    };
                    let task_name = sanitize_report_inline(task_name);
                    verification.push(format!("{task_name}：{outcome}"));
                }
            }

            let mut user_actions = Vec::new();
            if has_limitations {
                for finding in confirmed_findings {
                    user_actions.push(format!(
                        "**{confirmed_bug}**：{finding} 下一步：修复该位置后重放原验证。"
                    ));
                }
                for finding in risk_findings {
                    user_actions.push(format!(
                        "**{unverified}**：{finding} 下一步：核对项目约定并运行最小复现。"
                    ));
                }
                for task in test_failures.iter().chain(quality_failures.iter()) {
                    user_actions.push(format!(
                        "**{test_failure} · {}**：当前验证失败。下一步：修复失败位置后重新运行该验证。",
                        sanitize_report_inline(&task.name)
                    ));
                }
                for task in &environment_issues {
                    user_actions.push(format!(
                        "**{environment_problem} · {}**：{}。下一步：准备缺少的运行时或依赖，然后重新运行验证。",
                        sanitize_report_inline(&task.name),
                        Self::environment_issue_reason(task).unwrap_or("运行环境没有准备好")
                    ));
                }
                for task in &command_execution_issues {
                    let next_step = if task.status == TaskStatus::Paused {
                        "从已保存的检查点继续验证。"
                    } else {
                        "解除执行阻塞后，从未完成步骤重新验证。"
                    };
                    user_actions.push(format!(
                        "**{codepro_incomplete} · {}**：{}。下一步：{next_step}",
                        sanitize_report_inline(&task.name),
                        Self::task_failure_reason(task)
                    ));
                }
                for gap in &coverage_gaps {
                    user_actions.push(format!(
                        "**{unverified}**：{gap} 下一步：补充该范围的验证证据。"
                    ));
                }
                if run_result.current_files.is_empty() {
                    user_actions.push(format!("**{codepro_incomplete}**：当前没有可确认的修改文件。下一步：重新执行修改并确认目标文件写入成功。"));
                }
                if run_result.verification_groups.is_empty() {
                    user_actions.push(format!("**{unverified}**：当前修改尚未经过验证。下一步：运行与修改范围匹配的目标测试或检查。"));
                }
            }

            let mut technical_details = String::new();
            Self::append_cross_run_summary(&mut technical_details, dag);
            Self::append_technical_details(&mut technical_details, &run_result, dag);
            let technical_details = technical_details
                .replace("<details>\n<summary>查看运行记录（可选）</summary>\n\n", "")
                .replace("\n</details>", "")
                .trim()
                .to_string();
            let mut cross_run_summary = String::new();
            Self::append_cross_run_summary(&mut cross_run_summary, dag);
            let cross_run_summary = cross_run_summary.trim().to_string();
            if !cross_run_summary.is_empty() {
                verification.push(cross_run_summary);
            }
            return render_user_report_v1(&UserReportV1 {
                schema_version: 1,
                result,
                agent_results: Vec::new(),
                changes,
                verification,
                user_actions,
                technical_details: (!technical_details.is_empty())
                    .then_some(technical_details)
                    .into_iter()
                    .collect(),
            });
        }

        let mut report = format!("# CodePro 检查结果：{overall_state}\n\n## 结论\n\n");
        report.push_str(&conclusion);
        report.push_str("\n\n");
        report.push_str("## 检查情况\n\n");
        report.push_str(&format!(
            "- 已完成：{done_count} / {}\n- 已通过：{verification_passed} 项\n",
            dag.tasks.len()
        ));
        if dag_outcome == DagOutcome::Partial {
            report.push_str("- 汇总状态：部分完成；已保留成功结果并列出失败或跳过任务\n");
        }
        report.push_str(&format!("- 自动测试失败：{} 项\n", test_failures.len()));
        report.push_str(&format!("- 代码质量问题：{} 项\n", quality_failures.len()));
        report.push_str(&format!("- 已确认问题：{} 项\n", confirmed_findings.len()));
        report.push_str(&format!("- 待确认风险：{} 项\n", risk_findings.len()));
        if let Some(summary) = test_case_summary {
            report.push_str(&format!(
                "- 测试用例：{} 通过，{} 失败，{} 跳过\n",
                summary.passed, summary.failed, summary.skipped
            ));
        }
        report.push_str(&format!(
            "- 未运行或无法验证：{} 项\n",
            environment_issues.len() + coverage_gaps.len()
        ));
        report.push_str(&format!(
            "- CodePro 未完成：{} 项\n",
            command_execution_issues.len()
        ));
        report.push_str(&format!("- 等待继续：{} 项\n", paused_tasks.len()));
        report.push_str(&format!(
            "- 当前修改文件：{} 个\n",
            run_result.current_files.len()
        ));
        report.push_str(&format!(
            "- 当前审查结果：{} 项\n",
            run_result.review_summaries.len()
        ));
        if project_python_ready {
            report.push_str("- 环境恢复：已找到项目 Python 环境并成功启动 pytest\n");
        }

        if !confirmed_findings.is_empty() {
            report.push_str("\n## 已确认的 Bug\n\n");
            for finding in confirmed_findings {
                report.push_str(&format!("- {finding}\n"));
            }
        }
        if !risk_findings.is_empty() {
            report.push_str("\n## 高可信风险或改进建议\n\n");
            for finding in risk_findings {
                report.push_str(&format!("- {finding}\n"));
            }
        }
        if !test_failures.is_empty()
            || !quality_failures.is_empty()
            || !command_execution_issues.is_empty()
        {
            report.push_str("\n## 其他检查问题\n\n");
        }
        if !test_failures.is_empty() {
            report.push_str("### 自动测试失败\n\n");
            for task in &test_failures {
                report.push_str(&format!("- **{}**\n", sanitize_report_inline(&task.name)));
                let locations = Self::test_failure_locations(task);
                if locations.is_empty() {
                    report.push_str("  - 位置：测试输出没有提供可识别的测试名称\n");
                } else {
                    for location in locations {
                        let location = sanitize_report_inline(&location).replace('`', "\\`");
                        report.push_str(&format!("  - 位置：`{location}`\n"));
                    }
                }
                if let Some(summary) = Self::failure_summary(task) {
                    let summary = sanitize_report_block(&summary);
                    report.push_str(&format!("  - 结果：{summary}\n"));
                }
            }
        }
        if !quality_failures.is_empty() {
            report.push_str("\n### 代码质量问题\n\n");
            for task in &quality_failures {
                report.push_str(&format!("- **{}**\n", sanitize_report_inline(&task.name)));
                let locations = Self::quality_failure_locations(task);
                if locations.is_empty() {
                    report.push_str("  - 位置：质量工具没有提供可识别的文件位置\n");
                } else {
                    for location in locations {
                        let location = sanitize_report_inline(&location).replace('`', "\\`");
                        report.push_str(&format!("  - 位置：`{location}`\n"));
                    }
                }
            }
        }
        if !environment_issues.is_empty() || !coverage_gaps.is_empty() {
            report.push_str("\n## 未运行或无法验证\n\n");
        }
        if !environment_issues.is_empty() {
            for task in &environment_issues {
                report.push_str(&format!(
                    "- **{}**：{}\n",
                    sanitize_report_inline(&task.name),
                    Self::environment_issue_reason(task).unwrap_or("运行环境没有准备好")
                ));
            }
        }
        if !command_execution_issues.is_empty() {
            report.push_str("\n### CodePro 未完成\n\n");
            for task in &command_execution_issues {
                report.push_str(&format!(
                    "- **{}**：{}\n",
                    sanitize_report_inline(&task.name),
                    Self::task_failure_reason(task)
                ));
            }
        }
        if !coverage_gaps.is_empty() {
            for gap in &coverage_gaps {
                report.push_str(&format!("- {gap}\n"));
            }
        }

        report.push_str("\n## 下一步\n\n");
        if !confirmed_findings.is_empty()
            || !test_failures.is_empty()
            || !quality_failures.is_empty()
        {
            report.push_str("先修复上面已经确认的问题，再重新运行相关测试。\n");
        } else if !risk_findings.is_empty() {
            report.push_str(
                "先根据项目文档、类型声明、接口约定或明确用户场景核对待确认风险；确认违反预期后再修复。\n",
            );
        } else if !environment_issues.is_empty() && !command_execution_issues.is_empty() {
            report.push_str("先安装缺少的工具和依赖，再让 CodePro 用正确命令重新检查。\n");
        } else if !environment_issues.is_empty() {
            report.push_str("先安装项目需要的运行环境和依赖，然后重新检查。\n");
        } else if !command_execution_issues.is_empty() || !coverage_gaps.is_empty() {
            report.push_str("点击重新检查，让 CodePro 继续没有完成的部分。\n");
        } else {
            report.push_str("目前不用处理。\n");
        }

        Self::append_cross_run_summary(&mut report, dag);
        Self::append_technical_details(&mut report, &run_result, dag);
        report
    }

    fn task_evidence(task: &TaskNode) -> &str {
        task.output
            .as_ref()
            .and_then(|output| output.test_results.as_deref())
            .unwrap_or_default()
    }

    fn worker_change_report_conflicts_with_host(output: &TaskOutput) -> bool {
        if output.files_changed.is_empty() {
            return false;
        }

        let report = output.change_report.to_ascii_lowercase();
        [
            "没有修改任何文件",
            "未修改任何文件",
            "没有改动任何文件",
            "未改动任何文件",
            "no files changed",
            "no files were changed",
            "no files were modified",
            "did not change any file",
            "did not modify any file",
            "didn't change any file",
            "didn't modify any file",
        ]
        .iter()
        .any(|claim| report.contains(claim))
    }

    fn test_failure_locations(task: &TaskNode) -> Vec<String> {
        Self::unique_locations(
            Self::task_evidence(task)
                .lines()
                .filter_map(|line| {
                    let line = line.trim().trim_matches('_').trim();
                    line.strip_prefix("FAILED ")
                        .map(|location| location.split(" - ").next().unwrap_or(location).trim())
                        .or_else(|| {
                            (line.contains("::")
                                && !line.starts_with("- 命令")
                                && !line.starts_with("命令"))
                            .then_some(line)
                        })
                })
                .map(ToOwned::to_owned),
        )
    }

    fn quality_failure_locations(task: &TaskNode) -> Vec<String> {
        Self::unique_locations(
            Self::task_evidence(task)
                .lines()
                .filter_map(|line| line.trim().strip_prefix("--> ").map(str::trim))
                .map(ToOwned::to_owned),
        )
    }

    fn unique_locations(locations: impl Iterator<Item = String>) -> Vec<String> {
        let mut unique = Vec::new();
        for location in locations {
            if !location.is_empty() && !unique.contains(&location) {
                unique.push(location);
            }
            if unique.len() == 3 {
                break;
            }
        }
        unique
    }

    fn failure_summary(task: &TaskNode) -> Option<String> {
        Self::task_evidence(task)
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains(" failed")
                    && (lower.contains(" passed")
                        || lower
                            .chars()
                            .next()
                            .is_some_and(|character| character.is_ascii_digit()))
            })
            .map(|line| Self::truncate(line, 180))
    }

    fn task_failure_reason(task: &TaskNode) -> String {
        task.output
            .as_ref()
            .map(|output| output.change_report.trim())
            .filter(|reason| !reason.is_empty())
            .map(|reason| reason.trim_start_matches("失败原因:").trim())
            .map(|reason| Self::truncate(reason, 220))
            .map(|reason| sanitize_report_block(&reason))
            .unwrap_or_else(|| "任务没有返回可核验结果".to_string())
    }

    fn append_technical_details(report: &mut String, run_result: &CodeProRunResult, dag: &TaskDAG) {
        if run_result.tasks.is_empty()
            && dag.finding_candidates.is_empty()
            && dag.finding_validations.is_empty()
            && dag.finding_run_comparisons.is_empty()
            && dag.finding_false_positives.is_empty()
            && dag.finding_rerun_plan.is_empty()
        {
            return;
        }

        report.push_str("\n<details>\n<summary>查看运行记录（可选）</summary>\n\n");
        for task in &run_result.tasks {
            report.push_str(&format!(
                "### {} · {}\n\n",
                sanitize_report_inline(&task.id),
                sanitize_report_inline(&task.name)
            ));
            report.push_str(&format!("- 执行角色：{:?} Agent\n", task.role));
            report.push_str(&format!(
                "- 任务状态：{}\n",
                match task.status {
                    TaskStatus::Done => "已完成",
                    TaskStatus::Failed => "执行失败",
                    TaskStatus::Paused => "已保存检查点",
                    TaskStatus::Cancelled => "已停止",
                    TaskStatus::Skipped => "已跳过",
                    _ => "未完成",
                }
            ));
            report.push_str(&format!(
                "- 当前验证证据：{}\n",
                if task.has_current_verification {
                    "有"
                } else {
                    "无"
                }
            ));
            let Some(output) = &task.current_output else {
                report.push_str("- 当前证据：无\n\n");
                continue;
            };
            if output.files_changed.is_empty() {
                report.push_str("- 涉及文件：无\n");
            } else {
                report.push_str("- 涉及文件：\n");
                for file in &output.files_changed {
                    let file = sanitize_report_inline(file).replace('`', "\\`");
                    report.push_str(&format!("  - `{file}`\n"));
                }
            }
            if !output.change_report.trim().is_empty() {
                report.push_str("\nAgent 执行说明：\n\n");
                if Self::worker_change_report_conflicts_with_host(output) {
                    report.push_str("Agent 说明与宿主文件证据冲突，已忽略。\n");
                } else {
                    report.push_str(&sanitize_report_block(&Self::truncate(
                        output.change_report.trim(),
                        1_200,
                    )));
                }
                report.push('\n');
            }
            let verification_groups = run_result
                .verification_groups
                .iter()
                .filter(|group| group.task_id == task.id)
                .collect::<Vec<_>>();
            if !verification_groups.is_empty() {
                report.push_str("\n命令与结果：\n\n");
                for group in verification_groups {
                    let key = sanitize_report_inline(&group.key).replace('`', "\\`");
                    report.push_str(&format!("#### 当前结果 · `{key}`\n\n```text\n"));
                    report.push_str(
                        &Self::truncate(group.current.evidence.trim(), 3_000)
                            .replace("```", "` ` `"),
                    );
                    report.push_str("\n```\n");
                    if !group.history.is_empty() {
                        report.push_str("\n重试历史（仅供参考）：\n\n");
                        for (index, attempt) in group.history.iter().enumerate() {
                            report.push_str(&format!("##### 旧尝试 {}\n\n```text\n", index + 1));
                            report.push_str(
                                &Self::truncate(attempt.evidence.trim(), 3_000)
                                    .replace("```", "` ` `"),
                            );
                            report.push_str("\n```\n");
                        }
                    }
                }
            } else if let Some(evidence) = output
                .test_results
                .as_deref()
                .filter(|evidence| !evidence.trim().is_empty())
            {
                report.push_str("\n命令与结果：\n\n```text\n");
                report.push_str(&Self::truncate(evidence.trim(), 3_000).replace("```", "` ` `"));
                report.push_str("\n```\n");
            }
            report.push('\n');
        }
        if !dag.finding_candidates.is_empty() {
            report.push_str("## 候选问题验证\n\n");
            for candidate in dag.finding_candidates.iter().take(20) {
                report.push_str(&format!(
                    "### 候选 `{}`\n\n- 标题：{}\n",
                    sanitize_report_inline(&candidate.candidate_id).replace('`', "\\`"),
                    sanitize_report_inline(&Self::truncate(&candidate.title, 256))
                ));
                if let Some(location) = &candidate.location {
                    let path = sanitize_report_inline(&location.path.display().to_string())
                        .replace('`', "\\`");
                    report.push_str(&format!("- 位置：`{path}"));
                    if let Some(line) = location.line {
                        report.push_str(&format!(":{line}"));
                    }
                    report.push_str("`\n");
                } else {
                    report.push_str("- 位置：未提供\n");
                }
                let latest_validation = dag
                    .finding_validations
                    .iter()
                    .filter(|validation| validation.candidate_id == candidate.candidate_id)
                    .max_by_key(|validation| validation.validated_at);
                let Some(validation) = latest_validation else {
                    report.push_str("- 验证状态：not_validated\n\n");
                    continue;
                };
                report.push_str(&format!(
                    "- 验证状态：{}\n- 验证任务：`{}`\n- 输入摘要：{}\n- 输出摘要：{}\n",
                    Self::finding_validation_status_code(validation.status),
                    sanitize_report_inline(&validation.validator_task_id).replace('`', "\\`"),
                    sanitize_report_block(&Self::truncate(&validation.input_summary, 800)),
                    sanitize_report_block(&Self::truncate(&validation.output_summary, 800)),
                ));
                if validation.missing_evidence.is_empty() {
                    report.push_str("- 缺失证据：无\n");
                } else {
                    report.push_str("- 缺失证据：\n");
                    for missing in validation.missing_evidence.iter().take(20) {
                        report.push_str(&format!(
                            "  - {}\n",
                            sanitize_report_block(&Self::truncate(missing, 512))
                        ));
                    }
                }
                if let Some(evidence) = &validation.evidence {
                    let command = sanitize_report_inline(&Self::truncate(&evidence.command, 1_000))
                        .replace('`', "\\`");
                    let working_directory =
                        sanitize_report_inline(&evidence.working_directory.display().to_string())
                            .replace('`', "\\`");
                    report.push_str(&format!(
                        "- 宿主命令：`{command}`\n- 工作目录：`{working_directory}`\n- 退出码：{}\n",
                        evidence
                            .exit_code
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "未提供".to_string())
                    ));
                }
                report.push('\n');
            }
            if dag.finding_candidates.len() > 20 {
                report.push_str(&format!(
                    "另有 {} 个候选未在技术区展开。\n\n",
                    dag.finding_candidates.len() - 20
                ));
            }
        }
        if !dag.finding_run_comparisons.is_empty()
            || !dag.finding_false_positives.is_empty()
            || !dag.finding_rerun_plan.is_empty()
        {
            report.push_str("## 跨运行问题身份\n\n");
            for comparison in dag.finding_run_comparisons.iter().take(100) {
                let fingerprint =
                    sanitize_report_inline(&comparison.fingerprint).replace('`', "\\`");
                let path = sanitize_report_inline(&comparison.location.path.display().to_string())
                    .replace('`', "\\`");
                report.push_str(&format!(
                    "- `{fingerprint}` · {} · `{path}` · {}\n",
                    Self::finding_lifecycle_zh(comparison.lifecycle),
                    sanitize_report_inline(&comparison.reason)
                ));
            }
            if !dag.finding_false_positives.is_empty() {
                report.push_str("\n误报记录：\n\n");
                for record in dag.finding_false_positives.iter().take(50) {
                    report.push_str(&format!(
                        "- `{}` · {} · 条件 {} 项\n",
                        sanitize_report_inline(&record.fingerprint).replace('`', "\\`"),
                        sanitize_report_inline(&Self::truncate(&record.reason, 500)),
                        record.applicability.len()
                    ));
                }
            }
            if !dag.finding_rerun_plan.is_empty() {
                report.push_str("\n最小重跑计划：\n\n");
                for check_id in dag.finding_rerun_plan.iter().take(500) {
                    report.push_str(&format!(
                        "- `{}`\n",
                        sanitize_report_inline(check_id).replace('`', "\\`")
                    ));
                }
            }
            report.push('\n');
        }
        report.push_str("</details>\n");
    }

    fn status_icon(status: TaskStatus) -> &'static str {
        match status {
            TaskStatus::Done => "✅",
            TaskStatus::VerificationFailed | TaskStatus::RepairExhausted | TaskStatus::Failed => {
                "❌"
            }
            TaskStatus::RepairPending | TaskStatus::WaitingForUser | TaskStatus::Paused => "⏸️",
            TaskStatus::Cancelled => "🛑",
            TaskStatus::Skipped => "⏭️",
            TaskStatus::Running => "🔄",
            _ => "⏳",
        }
    }

    fn single_line(value: &str) -> String {
        sanitize_report_inline(value)
    }

    fn environment_issue_reason(task: &TaskNode) -> Option<&'static str> {
        let output = task.output.as_ref()?;
        let evidence = output.test_results.as_deref().unwrap_or_default();
        let combined = format!("{evidence}\n{}", output.change_report).to_ascii_lowercase();

        let last_pass = Self::latest_marker_position(
            &combined,
            &["结果：通过", "result: passed", "result: success"],
        );
        let environment_unavailable = Self::marker_is_unresolved(
            &combined,
            &[
                "结果：环境不可用",
                "environment unavailable",
                "运行环境没有准备好",
            ],
            last_pass,
        );
        let python_missing = Self::marker_is_unresolved(
            &combined,
            &[
                "windowsapps\\python",
                "windowsapps/python",
                "没有可用的 python",
                "找不到可用的 python",
                "无法找到可用的 python",
                "'python' is not recognized",
                "'py' is not recognized",
                "'python' 不是内部或外部命令",
                "'py' 不是内部或外部命令",
            ],
            last_pass,
        );
        let dependency_missing = Self::marker_is_unresolved(
            &combined,
            &[
                "no module named",
                "modulenotfounderror",
                "依赖未安装",
                "依赖缺失",
                "项目依赖也没有安装完整",
            ],
            last_pass,
        );

        match (python_missing, dependency_missing) {
            (true, true) => Some("运行环境没有准备好：缺少可用的 Python 或项目依赖。"),
            (true, false) => Some("运行环境没有准备好：电脑没有找到可用的 Python。"),
            (false, true) => Some("运行环境没有准备好：项目依赖没有安装完整。"),
            (false, false) if environment_unavailable => Some("运行环境没有准备好。"),
            _ => None,
        }
    }

    fn classified_findings(dag: &TaskDAG) -> ClassifiedFindings {
        let mut candidates: BTreeMap<String, (bool, String)> = BTreeMap::new();
        let mut structured_keys = HashSet::new();
        for candidate in &dag.finding_candidates {
            let location = candidate
                .location
                .as_ref()
                .map(|location| {
                    let mut value = location.path.display().to_string();
                    if let Some(line) = location.line {
                        value.push_str(&format!(":{line}"));
                    }
                    value
                })
                .unwrap_or_else(|| "未提供位置".to_string());
            let dedupe_key = Self::finding_dedupe_key(&location, &candidate.title);
            structured_keys.insert(dedupe_key.clone());
            let latest_validation = dag
                .finding_validations
                .iter()
                .filter(|validation| validation.candidate_id == candidate.candidate_id)
                .max_by_key(|validation| validation.validated_at);
            let (is_confirmed, evidence, contract) = latest_validation
                .map(|validation| {
                    let decision = classify_finding_validation(candidate, validation);
                    let reason = Self::finding_validation_reason_zh(decision.reason);
                    let summary = validation.output_summary.trim();
                    let mut evidence = if decision.confirmed {
                        if summary.is_empty() {
                            reason.to_string()
                        } else {
                            summary.to_string()
                        }
                    } else if summary.is_empty() {
                        reason.to_string()
                    } else {
                        format!("{reason}：{summary}")
                    };
                    if !decision.confirmed && !validation.missing_evidence.is_empty() {
                        evidence.push_str("；缺少：");
                        evidence.push_str(&validation.missing_evidence.join("、"));
                    }
                    (
                        decision.confirmed,
                        evidence,
                        decision.confirmed.then(|| {
                            candidate
                                .contract_reference
                                .as_deref()
                                .unwrap_or_default()
                                .to_string()
                        }),
                    )
                })
                .unwrap_or_else(|| (false, "尚无独立宿主验证".to_string(), None));
            let display = if let Some(contract) = contract {
                format!(
                    "**{}** {} | `{location}` | {evidence} | {contract}",
                    candidate.severity, candidate.title
                )
            } else {
                format!(
                    "**{}** {} | `{location}` | {evidence}",
                    candidate.severity, candidate.title
                )
            };
            candidates.insert(dedupe_key, (is_confirmed, display));
        }
        for task in &dag.tasks {
            let Some(report) = task
                .output
                .as_ref()
                .map(|output| output.change_report.as_str())
            else {
                continue;
            };
            let mut in_findings = false;
            for line in report.lines() {
                let line = line.trim();
                if line == "已确认问题："
                    || line == "已确认问题:"
                    || line == "待确认风险："
                    || line == "待确认风险:"
                    || line == "确认 Bug："
                    || line == "确认 Bug:"
                    || line == "未验证："
                    || line == "未验证:"
                {
                    in_findings = true;
                    continue;
                }
                if !in_findings {
                    continue;
                }
                if line.starts_with("验证：")
                    || line.starts_with("验证:")
                    || line.starts_with("未运行：")
                    || line.starts_with("未运行:")
                    || line.starts_with("限制：")
                    || line.starts_with("限制:")
                    || (!line.starts_with('-') && (line.ends_with('：') || line.ends_with(':')))
                {
                    break;
                }
                if line.starts_with("- [") && line.matches('|').count() >= 2 {
                    let parts = line
                        .trim_start_matches("- ")
                        .split('|')
                        .map(str::trim)
                        .collect::<Vec<_>>();
                    let summary = parts[0];
                    let location = parts[1].trim_matches('`');
                    let evidence = parts[2];
                    let contract = parts.get(3).copied().unwrap_or_default();
                    let dedupe_key = Self::finding_dedupe_key(location, summary);
                    if structured_keys.contains(&dedupe_key) {
                        continue;
                    }
                    let severity = summary
                        .strip_prefix('[')
                        .and_then(|value| value.split_once(']'))
                        .map(|(severity, _)| severity.trim())
                        .unwrap_or("未分级");
                    let title = summary
                        .split_once(']')
                        .map(|(_, title)| title.trim())
                        .unwrap_or(summary);
                    let contract_lower = contract.to_ascii_lowercase();
                    let has_host_verification = matches!(
                        Self::latest_verification_result(task),
                        Some("结果：通过" | "结果：测试失败" | "结果：检查失败")
                    );
                    let is_confirmed = has_host_verification
                        && !contract.is_empty()
                        && !contract.ends_with('无')
                        && !contract.ends_with("未知")
                        && !contract.ends_with("待确认")
                        && ["违反", "预期", "合同", "约定", "readme", "规格", "类型声明"]
                            .iter()
                            .any(|marker| contract_lower.contains(marker));
                    let display = if is_confirmed {
                        format!("**{severity}** {title} | `{location}` | {evidence} | {contract}")
                    } else {
                        format!("**{severity}** {title} | `{location}` | {evidence}")
                    };
                    match candidates.get(&dedupe_key) {
                        Some((already_confirmed, _)) if *already_confirmed || !is_confirmed => {}
                        _ => {
                            candidates.insert(dedupe_key, (is_confirmed, display));
                        }
                    }
                }
            }
        }
        let mut findings = ClassifiedFindings::default();
        for (_, (is_confirmed, display)) in candidates {
            if is_confirmed {
                let id = format!("BUG-{:03}", findings.confirmed.len() + 1);
                let display = display.replacen("**", &format!("**{id} · "), 1);
                findings.confirmed.push(Self::truncate(&display, 600));
            } else {
                let id = format!("RISK-{:03}", findings.risks.len() + 1);
                let display = display.replacen("**", &format!("**{id} · "), 1);
                findings.risks.push(Self::truncate(&display, 500));
            }
        }
        findings
    }

    fn finding_validation_reason_zh(reason: FindingValidationDecisionReason) -> &'static str {
        match reason {
            FindingValidationDecisionReason::Confirmed => "宿主验证已确认",
            FindingValidationDecisionReason::NotReproduced => "宿主未能复现",
            FindingValidationDecisionReason::EnvironmentBlocked => "验证被环境阻塞",
            FindingValidationDecisionReason::CoverageGap => "验证覆盖不足",
            FindingValidationDecisionReason::AgentIncomplete => "验证任务未完成",
            FindingValidationDecisionReason::InsufficientEvidence => "验证证据不足",
            FindingValidationDecisionReason::UnknownStatus => "验证状态未知",
            FindingValidationDecisionReason::CandidateMismatch => "候选与验证不匹配",
            FindingValidationDecisionReason::MissingLocation => "缺少问题位置",
            FindingValidationDecisionReason::MissingContract => "缺少合同依据",
            FindingValidationDecisionReason::MissingHostEvidence => "缺少宿主执行证据",
            FindingValidationDecisionReason::MissingInputSummary => "缺少验证输入摘要",
            FindingValidationDecisionReason::MissingOutputSummary => "缺少验证输出摘要",
            FindingValidationDecisionReason::InvalidCandidate => "候选问题记录无效",
            FindingValidationDecisionReason::InvalidValidation => "验证记录无效",
        }
    }

    fn finding_validation_status_code(status: FindingValidationStatus) -> &'static str {
        match status {
            FindingValidationStatus::Confirmed => "confirmed",
            FindingValidationStatus::NotReproduced => "not_reproduced",
            FindingValidationStatus::EnvironmentBlocked => "environment_blocked",
            FindingValidationStatus::CoverageGap => "coverage_gap",
            FindingValidationStatus::AgentIncomplete => "agent_incomplete",
            FindingValidationStatus::InsufficientEvidence => "insufficient_evidence",
            FindingValidationStatus::Unknown => "unknown",
        }
    }

    fn append_cross_run_summary(report: &mut String, dag: &TaskDAG) {
        if dag.finding_run_comparisons.is_empty() {
            return;
        }
        let count = |lifecycle| {
            dag.finding_run_comparisons
                .iter()
                .filter(|comparison| comparison.lifecycle == lifecycle)
                .count()
        };
        report.push_str("\n## 与上次检查相比\n\n");
        report.push_str(&format!(
            "- 新增：{} 项\n- 持续：{} 项\n- 重新出现：{} 项\n- 已解决：{} 项\n- 未知：{} 项\n",
            count(FindingLifecycle::New),
            count(FindingLifecycle::Persisting),
            count(FindingLifecycle::Reopened),
            count(FindingLifecycle::Resolved),
            count(FindingLifecycle::Unknown)
        ));
        for comparison in dag.finding_run_comparisons.iter().take(20) {
            let path = sanitize_report_inline(&comparison.location.path.display().to_string())
                .replace('`', "\\`");
            report.push_str(&format!(
                "- **{}** · `{path}`：{}\n",
                Self::finding_lifecycle_zh(comparison.lifecycle),
                sanitize_report_inline(&comparison.reason)
            ));
        }
    }

    fn finding_lifecycle_zh(lifecycle: FindingLifecycle) -> &'static str {
        match lifecycle {
            FindingLifecycle::New => "新增",
            FindingLifecycle::Persisting => "持续",
            FindingLifecycle::Reopened => "重新出现",
            FindingLifecycle::Resolved => "已解决",
            FindingLifecycle::Unknown => "未知",
        }
    }

    fn is_agent_execution_issue(task: &TaskNode, project_python_ready: bool) -> bool {
        if Self::environment_issue_is_unresolved(task, project_python_ready) {
            return false;
        }

        match Self::latest_verification_result(task) {
            Some("结果：命令执行失败") => true,
            Some("结果：测试失败" | "结果：检查失败" | "结果：环境不可用" | "结果：未发现测试") => {
                false
            }
            _ => matches!(
                task.status,
                TaskStatus::Failed
                    | TaskStatus::Paused
                    | TaskStatus::Cancelled
                    | TaskStatus::Skipped
            ),
        }
    }

    fn finding_dedupe_key(location: &str, summary: &str) -> String {
        let primary_location = location
            .split([',', '，', '、'])
            .next()
            .unwrap_or(location)
            .trim()
            .trim_matches('`')
            .to_ascii_lowercase();
        if primary_location.is_empty() {
            summary.to_ascii_lowercase()
        } else {
            primary_location
        }
    }

    fn environment_issue_is_unresolved(task: &TaskNode, project_python_ready: bool) -> bool {
        Self::environment_issue_reason(task).is_some()
            && !Self::environment_issue_is_resolved(task, project_python_ready)
    }

    fn environment_issue_is_resolved(task: &TaskNode, project_python_ready: bool) -> bool {
        project_python_ready
            && Self::environment_issue_reason(task)
                == Some("运行环境没有准备好：电脑没有找到可用的 Python。")
    }

    fn project_python_test_environment_ready(dag: &TaskDAG) -> bool {
        dag.tasks.iter().any(|task| {
            let Some(output) = &task.output else {
                return false;
            };
            let evidence = output.test_results.as_deref().unwrap_or_default();
            let lower = evidence.to_ascii_lowercase();
            let invoked_python_test = lower.contains("pytest")
                && (lower.contains(".venv")
                    || lower.contains("python.exe")
                    || lower.contains("python -m pytest"));
            let test_process_started = lower.contains("test session starts")
                || lower.contains("collected ")
                || lower.contains(" passed")
                || lower.contains(" failed")
                || evidence.contains("结果：通过")
                || evidence.contains("结果：测试失败");
            let pytest_missing = lower.contains("no module named pytest")
                || lower.contains("'pytest' 不是内部或外部命令");
            invoked_python_test && test_process_started && !pytest_missing
        })
    }

    fn latest_verification_result(task: &TaskNode) -> Option<&'static str> {
        let evidence = Self::task_evidence(task);
        [
            "结果：通过",
            "结果：测试失败",
            "结果：检查失败",
            "结果：环境不可用",
            "结果：命令执行失败",
            "结果：未发现测试",
        ]
        .into_iter()
        .filter_map(|marker| evidence.rfind(marker).map(|position| (position, marker)))
        .max_by_key(|(position, _)| *position)
        .map(|(_, marker)| marker)
    }

    fn test_case_summary(dag: &TaskDAG) -> Option<TestCaseSummary> {
        let mut best = None;
        for task in &dag.tasks {
            let Some(output) = &task.output else {
                continue;
            };
            let combined = format!(
                "{}\n{}",
                output.test_results.as_deref().unwrap_or_default(),
                output.change_report
            );
            for line in combined.lines() {
                let lower = line.to_ascii_lowercase();
                let passed = Self::number_before_marker(&lower, "passed").unwrap_or(0);
                let failed = Self::number_before_marker(&lower, "failed").unwrap_or(0);
                let skipped = Self::number_before_marker(&lower, "skipped").unwrap_or(0);
                let mut candidate = (passed + failed + skipped > 0).then_some(TestCaseSummary {
                    passed,
                    failed,
                    skipped,
                });
                if let Some((passed, total)) = Self::chinese_fraction_summary(line) {
                    candidate = Some(TestCaseSummary {
                        passed,
                        failed: total.saturating_sub(passed),
                        skipped: 0,
                    });
                }
                if let Some(candidate) = candidate {
                    let candidate_total = candidate.passed + candidate.failed + candidate.skipped;
                    let best_total = best
                        .map(|summary: TestCaseSummary| {
                            summary.passed + summary.failed + summary.skipped
                        })
                        .unwrap_or(0);
                    if candidate_total > best_total {
                        best = Some(candidate);
                    }
                }
            }
        }
        best
    }

    fn number_before_marker(line: &str, marker: &str) -> Option<usize> {
        let marker_position = line.find(marker)?;
        let prefix = line.get(..marker_position)?.trim_end();
        let digits = prefix
            .chars()
            .rev()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
    }

    fn chinese_fraction_summary(line: &str) -> Option<(usize, usize)> {
        let pass_marker = line.find("通过")?;
        let prefix = line.get(..pass_marker)?.trim_end();
        let fraction = prefix
            .split_whitespace()
            .last()
            .unwrap_or(prefix)
            .trim_matches(|character: char| !character.is_ascii_digit() && character != '/');
        let (passed, total) = fraction.split_once('/')?;
        Some((passed.parse().ok()?, total.parse().ok()?))
    }

    fn latest_marker_position(value: &str, markers: &[&str]) -> Option<usize> {
        markers
            .iter()
            .filter_map(|marker| value.rfind(marker))
            .max()
    }

    fn marker_is_unresolved(value: &str, markers: &[&str], last_pass: Option<usize>) -> bool {
        Self::latest_marker_position(value, markers)
            .is_some_and(|position| last_pass.is_none_or(|pass| position > pass))
    }

    fn coverage_gaps(dag: &TaskDAG) -> Vec<String> {
        let mut gaps = BTreeMap::new();
        for task in &dag.tasks {
            let Some(evidence) = task
                .output
                .as_ref()
                .and_then(|output| output.test_results.as_deref())
            else {
                continue;
            };
            if evidence.contains("结果：未发现测试") {
                gaps.entry(format!("no-tests:{}", task.name))
                    .or_insert_with(|| format!("{}：测试命令没有找到可运行的测试", task.name));
            }
            let mut found_named_skip = false;
            for line in evidence.lines() {
                let lower = line.to_ascii_lowercase();
                if !lower.contains("skipped [") {
                    continue;
                }
                found_named_skip = true;
                let display = Self::truncate(line.trim(), 220);
                let key = display
                    .split_once(": ")
                    .map(|(location, _)| location)
                    .unwrap_or(&display)
                    .to_ascii_lowercase();
                gaps.entry(format!("skipped:{key}")).or_insert(display);
            }
            if !found_named_skip {
                if let Some(summary) = evidence
                    .lines()
                    .map(str::trim)
                    .find(|line| line.to_ascii_lowercase().contains(" skipped"))
                {
                    gaps.entry(format!("skipped-summary:{}", task.name))
                        .or_insert_with(|| {
                            format!(
                                "{}：有测试被跳过（{}）",
                                task.name,
                                Self::truncate(summary, 160)
                            )
                        });
                }
            }
        }
        gaps.into_values().collect()
    }

    fn truncate(value: &str, max_chars: usize) -> String {
        if value.chars().count() <= max_chars {
            value.to_string()
        } else {
            format!("{}…", value.chars().take(max_chars).collect::<String>())
        }
    }
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::agent_role::{AgentRole, CodeProTaskKind};

    #[test]
    fn failed_dependency_still_produces_an_explicit_partial_summary() {
        let task =
            |id: &str, role: AgentRole, depends_on: Vec<&str>, status: TaskStatus| TaskNode {
                id: id.to_string(),
                name: format!("任务 {id}"),
                description: format!("执行 {id}"),
                role,
                depends_on: depends_on.into_iter().map(str::to_string).collect(),
                acceptance_criteria: "保留可核验的宿主证据".to_string(),
                status,
                output: None,
                retry_count: 0,
            };
        let mut dag = TaskDAG::new(
            "验证失败依赖仍有汇总",
            vec![
                task("passed", AgentRole::Tester, vec![], TaskStatus::Done),
                task("failed", AgentRole::Tester, vec![], TaskStatus::Failed),
                task(
                    "blocked",
                    AgentRole::Tester,
                    vec!["failed"],
                    TaskStatus::Pending,
                ),
            ],
        );
        dag.skip_tasks_blocked_by_failure();

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.starts_with("# 任务报告"));
        assert!(report.contains("任务 failed"));
        assert!(report.contains("任务 blocked"));
        assert!(!report.contains("检查已完成，目前没有发现需要处理的问题"));
    }

    #[test]
    fn progress_is_readable_and_contains_task_statuses() {
        let dag = TaskDAG::new(
            "目标",
            vec![
                TaskNode {
                    id: "task-1".to_string(),
                    name: "实现".to_string(),
                    description: String::new(),
                    role: AgentRole::Coder,
                    depends_on: vec![],
                    acceptance_criteria: "通过".to_string(),
                    status: TaskStatus::Done,
                    output: None,
                    retry_count: 0,
                },
                TaskNode {
                    id: "task-2".to_string(),
                    name: "测试".to_string(),
                    description: String::new(),
                    role: AgentRole::Coder,
                    depends_on: vec![],
                    acceptance_criteria: "通过".to_string(),
                    status: TaskStatus::Cancelled,
                    output: None,
                    retry_count: 0,
                },
            ],
        );

        assert_eq!(
            ResultAggregator::build_progress(&dag, "执行中"),
            concat!(
                "CodePro · 执行中\n",
                "进度：1 / 2 个任务已完成\n",
                "最近结果：task-2 · 测试已停止\n",
                "--- CodePro 任务快照 ---\n",
                "✅ task-1: 实现\n",
                "🛑 task-2: 测试\n"
            )
        );
    }

    #[test]
    fn progress_does_not_render_verification_failure_as_queued_or_passed() {
        let dag = TaskDAG::new(
            "测试项目",
            vec![TaskNode {
                id: "task-test".to_string(),
                name: "运行项目测试".to_string(),
                description: String::new(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "测试通过".to_string(),
                status: TaskStatus::VerificationFailed,
                output: None,
                retry_count: 0,
            }],
        );

        let progress = ResultAggregator::build_progress(&dag, "正在准备自动修复");

        assert!(progress.contains("最近结果：task-test · 运行项目测试验证失败"));
        assert!(progress.contains("❌ task-test: 运行项目测试"));
        assert!(!progress.contains("✅ task-test"));
        assert!(!progress.contains("⏳ task-test"));
    }

    #[test]
    fn paused_agent_is_reported_as_saved_progress_not_a_test_failure() {
        let message = "本轮操作测试 Agent 行动已上限，当前进度已经保存。CodePro 将从检查点继续执行。您可以点击重试继续执行。";
        let dag = TaskDAG::new(
            "目标",
            vec![TaskNode {
                id: "task-1".to_string(),
                name: "运行测试".to_string(),
                description: String::new(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "完成测试".to_string(),
                status: TaskStatus::Paused,
                output: Some(crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: message.to_string(),
                    test_results: None,
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            }],
        );

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.starts_with("# 任务报告"));
        assert!(report.contains(message));
        assert!(!report.contains("测试失败：0 项"));
        assert!(report.contains("CodePro 未完成：1 项"));
    }

    #[test]
    fn project_test_failure_and_paused_agent_are_counted_independently() {
        let test_failure = TaskNode {
            id: "test-failure".to_string(),
            name: "运行项目测试".to_string(),
            description: String::new(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告真实结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "项目测试已执行。".to_string(),
                test_results: Some(
                    "命令：cargo test\n结果：测试失败\n退出码：1\n输出：1 failed".to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let paused_agent = TaskNode {
            id: "agent-paused".to_string(),
            name: "继续代码审查".to_string(),
            description: String::new(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "完成审查".to_string(),
            status: TaskStatus::Paused,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "行动预算已到收尾区，检查点已保存。".to_string(),
                test_results: None,
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(
            &TaskDAG::new("检查项目", vec![test_failure, paused_agent]),
            &[],
        );

        assert!(report.starts_with("# 任务报告"));
        assert!(report.contains("**测试失败 · 运行项目测试**：当前验证失败"));
        assert!(report.contains("**CodePro 未完成 · 继续代码审查**"));
        assert!(report.contains("从已保存的检查点继续验证"));
    }

    #[test]
    fn progress_explains_the_current_task_for_expandable_activity_details() {
        let dag = TaskDAG::new(
            "测试项目",
            vec![TaskNode {
                id: "task-test".to_string(),
                name: "运行完整测试".to_string(),
                description: "执行项目已有测试并保留真实输出".to_string(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "列出通过、失败和跳过数量".to_string(),
                status: TaskStatus::Running,
                output: None,
                retry_count: 0,
            }],
        );

        let progress =
            ResultAggregator::build_progress(&dag, "正在执行运行完整测试（Tester Agent）");

        assert!(progress.contains("当前任务：task-test · 运行完整测试"));
        assert!(progress.contains("说明：执行项目已有测试并保留真实输出"));
        assert!(progress.contains("验收目标：列出通过、失败和跳过数量"));
        assert!(progress.contains("--- CodePro 任务快照 ---"));
        assert!(progress.contains("🔄 task-test: 运行完整测试"));
    }

    #[test]
    fn beginner_report_does_not_show_tokens_or_costs() {
        let mut task = TaskNode {
            id: "task-usage".to_string(),
            name: "实现".to_string(),
            description: String::new(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "通过".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: "diff".to_string(),
                change_report: "完成".to_string(),
                test_results: None,
                files_changed: vec!["app.rs".to_string()],
                validation_not_run: None,
                usage: Some(crate::agents::task_dag::TaskUsage {
                    input_tokens: 120,
                    output_tokens: 30,
                    total_tokens: 150,
                    cost_usd: Some(0.0123),
                }),
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("目标", vec![task.clone()]);
        task.status = TaskStatus::Done;

        let report = ResultAggregator::build_report(&dag, &[task]);

        assert!(report.contains("# 任务报告"));
        assert!(!report.contains("Token"));
        assert!(!report.contains("$0.0123"));
    }

    #[test]
    fn test_report_leads_with_a_plain_language_conclusion_and_next_step() {
        let task = TaskNode {
            id: "task-test".to_string(),
            name: "运行完整测试".to_string(),
            description: "运行项目已有的完整测试套件".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告通过、失败和跳过数量".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "已完成测试，发现两个失败。".to_string(),
                test_results: Some(
                    "命令：pytest\n结果：测试失败\n退出码：1\n输出：2 failed, 490 passed"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("测试项目", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        assert!(report.starts_with("# 任务报告"));
        assert!(report.contains("测试失败已经由当前命令证据确认"));
        assert!(report.contains("测试失败：1 项"));
        assert!(report.contains("位置：测试输出没有提供可识别的测试名称"));
        assert!(report.contains("### 接下来需要你做什么"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(!beginner_summary.contains("pytest"));
        assert!(!beginner_summary.contains("Tester Agent"));
    }

    #[test]
    fn test_report_uses_the_planned_section_order() {
        let task = |id: &str,
                    name: &str,
                    status: TaskStatus,
                    change_report: &str,
                    evidence: Option<&str>|
         -> TaskNode {
            TaskNode {
                id: id.to_string(),
                name: name.to_string(),
                description: name.to_string(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "报告当前宿主证据".to_string(),
                status,
                output: Some(crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: change_report.to_string(),
                    test_results: evidence.map(str::to_string),
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            }
        };
        let mut dag = TaskDAG::new(
            "测试项目",
            vec![
                task(
                    "pass",
                    "登录检查",
                    TaskStatus::Done,
                    "登录测试通过。",
                    Some("命令：cargo test -p secret-login\n结果：通过\n退出码：0\n输出：4 passed"),
                ),
                task(
                    "failure",
                    "协议检查",
                    TaskStatus::Done,
                    "已确认问题：\n- [高] 状态码不符合合同 | src/api.rs:12 | 复现 500 | 违反：接口约定\n验证：已执行",
                    Some("命令：cargo test api_contract\n结果：测试失败\n退出码：1\n输出：1 failed"),
                ),
                task(
                    "environment",
                    "外部环境检查",
                    TaskStatus::Done,
                    "环境不可用。",
                    Some("命令：python -m pytest\n结果：环境不可用\n退出码：1\n输出：No module named pytest"),
                ),
                TaskNode {
                    id: "missing".to_string(),
                    name: "缺少证据的检查".to_string(),
                    description: "缺少证据的检查".to_string(),
                    role: AgentRole::Tester,
                    depends_on: vec![],
                    acceptance_criteria: "必须返回证据".to_string(),
                    status: TaskStatus::Done,
                    output: None,
                    retry_count: 0,
                },
            ],
        );
        dag.task_kind = Some(CodeProTaskKind::ProjectTest);

        let report = ResultAggregator::build_report(&dag, &[]);
        let headings = [
            "# 任务报告",
            "## 执行 Agent",
            "## 总结",
            "### 接下来需要你做什么",
            "<details>",
        ];
        let positions = headings
            .iter()
            .map(|heading| {
                assert_eq!(report.matches(heading).count(), 1, "{heading}\n{report}");
                report.find(heading).unwrap()
            })
            .collect::<Vec<_>>();

        assert!(report.starts_with("# 任务报告"));
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        let beginner = report
            .get(..positions[4])
            .expect("details position comes from a UTF-8 marker");
        let technical = report
            .get(positions[4]..)
            .expect("details position comes from a UTF-8 marker");
        assert!(beginner.contains("BUG-001"));
        assert!(beginner.contains("登录检查"));
        assert!(beginner.contains("缺少证据的检查"));
        assert!(!beginner.contains("cargo test -p secret-login"));
        assert!(!beginner.contains("Tester Agent"));
        assert!(technical.contains("cargo test -p secret-login"));
    }

    #[test]
    fn test_report_uses_host_owned_wording_location_and_next_steps() {
        let task = |id: &str,
                    name: &str,
                    status: TaskStatus,
                    change_report: &str,
                    evidence: Option<&str>|
         -> TaskNode {
            TaskNode {
                id: id.to_string(),
                name: name.to_string(),
                description: name.to_string(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "按宿主证据分类".to_string(),
                status,
                output: Some(crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: change_report.to_string(),
                    test_results: evidence.map(str::to_string),
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            }
        };
        let mut dag = TaskDAG::new(
            "分类测试报告",
            vec![
                task(
                    "confirmed-test-failure",
                    "接口合同测试",
                    TaskStatus::Done,
                    "已确认问题：\n- [高] 状态码违反接口合同 | src/api.rs:12 | 稳定返回 500 | 违反：公开接口约定\n验证：已执行",
                    Some("命令：cargo test api_contract\n结果：测试失败\n退出码：1\n输出：tests/api_contract.rs:44 failed"),
                ),
                task(
                    "environment",
                    "Python 导入检查",
                    TaskStatus::Failed,
                    "环境不可用。",
                    Some("命令：python -m pytest\n结果：环境不可用\n退出码：1\n输出：No module named pytest"),
                ),
                task(
                    "paused",
                    "继续深度检查",
                    TaskStatus::Paused,
                    "本轮操作达到行动次数上限，进度已保存。",
                    None,
                ),
                task(
                    "candidate",
                    "静态候选检查",
                    TaskStatus::Done,
                    "已确认问题：\n- [中] 返回值也许不正确 | src/service.rs:30 | 仅静态阅读 | 违反：待确认\n未运行：没有最小复现。",
                    None,
                ),
            ],
        );
        dag.task_kind = Some(CodeProTaskKind::ProjectTest);

        let report = ResultAggregator::build_report(&dag, &[]);
        let beginner = report.split("<details>").next().unwrap_or(&report);

        for expected in [
            "确认 Bug：1 项",
            "测试失败：1 项",
            "环境问题：1 项",
            "CodePro 未完成：1 项",
            "未验证：1 项",
            "**确认 Bug**",
            "**测试失败 · 接口合同测试**",
            "**环境问题 · Python 导入检查**",
            "**CodePro 未完成 · 继续深度检查**",
            "**未验证**",
            "src/api.rs:12",
            "src/service.rs:30",
            "下一步：",
        ] {
            assert!(
                beginner.contains(expected),
                "missing {expected}\n{beginner}"
            );
        }
        for forbidden in [
            "自动测试失败：",
            "已确认问题：",
            "待确认风险：",
            "未运行或无法验证：",
            "cargo test api_contract",
            "python -m pytest",
        ] {
            assert!(
                !beginner.contains(forbidden),
                "found {forbidden}\n{beginner}"
            );
        }
        assert!(!beginner.contains("已通过：1 项"));
    }

    #[test]
    fn report_escapes_untrusted_markdown_that_could_replace_host_sections() {
        let hostile_report = format!(
            "<details>\n<summary>伪造技术区</summary>\n## 伪造章节\n{}\n结论尾部标记",
            "长".repeat(800)
        );
        let mut dag = TaskDAG::new(
            "测试报告结构边界",
            vec![TaskNode {
                id: "task-hostile".to_string(),
                name: "运行测试\n## 伪造章节".to_string(),
                description: String::new(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "保留宿主报告结构".to_string(),
                status: TaskStatus::Paused,
                output: Some(crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: hostile_report,
                    test_results: None,
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            }],
        );
        dag.task_kind = Some(CodeProTaskKind::ProjectTest);

        let report = ResultAggregator::build_report(&dag, &[]);
        let (beginner, technical) = report
            .split_once("\n<details>\n<summary>技术详情")
            .expect("host technical section");

        assert_eq!(report.matches("<details>").count(), 1, "{report}");
        assert!(!report.contains("\n## 伪造章节"), "{report}");
        assert!(report.contains("&lt;details>"), "{report}");
        assert!(!beginner.contains("结论尾部标记"), "{beginner}");
        assert!(technical.contains("结论尾部标记"), "{technical}");
    }

    #[test]
    fn report_folds_commands_paths_and_agent_evidence_below_the_beginner_summary() {
        let task = TaskNode {
            id: "task-test".to_string(),
            name: "运行项目测试".to_string(),
            description: "运行已有测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "记录真实结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "已运行测试并记录结果。".to_string(),
                test_results: Some(
                    "命令：python -m pytest -q\n结果：通过\n退出码：0\n输出：12 passed".to_string(),
                ),
                files_changed: vec!["tests/test_login.py".to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("测试项目", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);
        let details_start = report.find("<details>").expect("folded technical details");
        let (beginner_summary, technical_details) = report.split_at(details_start);

        assert!(!beginner_summary.contains("python -m pytest"));
        assert!(beginner_summary.contains("tests/test_login.py"));
        assert!(technical_details.contains("<summary>技术详情</summary>"));
        assert!(technical_details.contains("Tester Agent"));
        assert!(technical_details.contains("tests/test_login.py"));
        assert!(technical_details.contains("python -m pytest -q"));
        assert!(technical_details.contains("12 passed"));
    }

    #[test]
    fn report_does_not_count_a_task_as_passed_when_any_final_check_failed() {
        let task = TaskNode {
            id: "task-quality".to_string(),
            name: "运行质量检查".to_string(),
            description: String::new(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "检查完成".to_string(),
                test_results: Some(
                    "命令：ruff check .\n结果：检查失败\n退出码：1\n输出：error\n\
                     命令：pip check\n结果：通过\n退出码：0\n输出：No broken requirements"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("检查项目", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("测试失败：1 项"));
        assert!(report.contains("已通过：0 项"));
    }

    #[test]
    fn report_separates_project_findings_from_codepro_failures_and_coverage_gaps() {
        let finding = TaskNode {
            id: "task-probe".to_string(),
            name: "运行 IPC 缺陷探测".to_string(),
            description: "运行协议边界测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告真实结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "确认 IPC 错误码不符合协议约定".to_string(),
                test_results: Some(
                    "已执行 1 条可核验命令：\n- 命令：{\"command\":\"python -m pytest temp_probe_tests -q\"}\n  结果：测试失败\n  退出码：1\n  输出：\n1 failed, 69 passed, 2 skipped"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let timed_out = TaskNode {
            id: "task-review".to_string(),
            name: "审查已知问题".to_string(),
            description: "阅读历史报告".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "逐项确认".to_string(),
            status: TaskStatus::Failed,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "Agent 执行超过 300 秒，已停止本次尝试".to_string(),
                test_results: None,
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("测试项目", vec![finding, timed_out]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("测试失败：1 项"));
        assert!(report.contains("CodePro 未完成：1 项"));
        assert!(report.contains("未验证：1 项"));
        assert!(!report.contains("可能有 Bug"));
        assert!(report.contains("temp_probe_tests"));
        assert!(report.contains("69 passed"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(!beginner_summary.contains("python -m pytest"));
        assert!(beginner_summary.contains("1 failed"));
    }

    #[test]
    fn report_names_the_exact_pytest_failure_and_quality_file() {
        let task = TaskNode {
            id: "task-1".to_string(),
            name: "基础质量门验证".to_string(),
            description: "运行测试和质量检查".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告具体失败位置".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "测试与质量检查完成".to_string(),
                test_results: Some(
                    "结果：测试失败\n退出码：1\n输出：\n\
                     FAILED tests/unit/test_bug_verification.py::TestBugTM01_CascadingBlocking::test_blocked\n\
                     1 failed, 501 passed\n\
                     结果：检查失败\n退出码：1\n输出：\n\
                     F841 Local variable is never used\n\
                     --> temp_probe_tests/probe_ipc_failclosed.py:232:9"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let report = ResultAggregator::build_report(&TaskDAG::new("检查项目", vec![task]), &[]);
        let summary = report.split("<details>").next().unwrap_or(&report);

        assert!(summary.contains(
            "tests/unit/test_bug_verification.py::TestBugTM01_CascadingBlocking::test_blocked"
        ));
        assert!(summary.contains("temp_probe_tests/probe_ipc_failclosed.py:232:9"));
        assert!(summary.contains("测试失败：2 项"));
        assert!(!summary.contains("## 高可信风险或改进建议"));
        assert!(!summary.contains("可能"));
    }

    #[test]
    fn report_does_not_call_a_quality_check_failure_a_confirmed_bug() {
        let task = TaskNode {
            id: "task-lint".to_string(),
            name: "运行 Ruff 检查".to_string(),
            description: "检查代码质量".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告检查结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report:
                    "发现一个无用 noqa 注释，不影响程序运行，不属于真实 Bug。".to_string(),
                test_results: Some(
                    "命令：ruff check . --select RUF100\n结果：检查失败\n退出码：1\n输出：Unused noqa directive"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("检查项目 Bug", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("测试失败：1 项"));
        assert!(!report.contains("业务 Bug"));
    }

    #[test]
    fn report_deduplicates_the_same_skipped_scenario_across_tasks() {
        let skipped_evidence = "命令：pytest -q\n结果：通过\n退出码：0\n输出：\n\
                                SKIPPED [1] tests/test_ui.py:10: requires desktop runtime\n\
                                10 passed, 1 skipped";
        let make_task = |id: &str| TaskNode {
            id: id.to_string(),
            name: "运行测试".to_string(),
            description: "运行测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "测试完成".to_string(),
                test_results: Some(skipped_evidence.to_string()),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("测试项目", vec![make_task("task-1"), make_task("task-2")]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("未验证：1 项"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(beginner_summary.contains("tests/test_ui.py"));
    }

    #[test]
    fn report_keeps_agent_narrative_out_of_the_beginner_summary() {
        let task = TaskNode {
            id: "task-test".to_string(),
            name: "运行测试".to_string(),
            description: "运行测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!(
                    "结论：测试通过。\n\n{}",
                    "这是很长的 Agent 技术分析。".repeat(300)
                ),
                test_results: Some(
                    "命令：pytest -q\n结果：通过\n退出码：0\n输出：10 passed".to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("测试项目", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(!beginner_summary.contains("Agent 技术分析"));
        assert!(beginner_summary.len() < 1_000);
        assert!(report.contains("<summary>技术详情</summary>"));
        assert!(report.len() < 6_000);
    }

    #[test]
    fn report_keeps_bounded_coder_summary_and_structured_verification_evidence() {
        let coder = TaskNode {
            id: "task-code".to_string(),
            name: "修改实现".to_string(),
            description: "修改实现".to_string(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "完成修改".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: "diff --git a/src/lib.rs b/src/lib.rs".to_string(),
                change_report: "已完成目标修改。\n…（Coder 完整报告已保存在角色会话）".to_string(),
                test_results: None,
                files_changed: vec!["src/lib.rs".to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let tester = TaskNode {
            id: "task-test".to_string(),
            name: "验证修改".to_string(),
            description: "验证修改".to_string(),
            role: AgentRole::Tester,
            depends_on: vec!["task-code".to_string()],
            acceptance_criteria: "真实命令退出码为 0".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "相关测试通过。".to_string(),
                test_results: Some(
                    "命令：cargo test focused\n结果：通过\n退出码：0\n输出：1 passed".to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("修改并验证", vec![coder, tester]);

        let report = ResultAggregator::build_report(&dag, &[]);
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);

        assert!(!beginner_summary.contains("Coder 完整报告"));
        assert!(report.contains("Coder 完整报告已保存在角色会话"));
        assert!(report.contains("`src/lib.rs`"));
        assert!(report.contains("cargo test focused"));
        assert!(report.contains("退出码：0"));
    }

    #[test]
    fn host_file_evidence_wins_over_a_contradictory_worker_narrative() {
        let coder = TaskNode {
            id: "task-code".to_string(),
            name: "修改实现".to_string(),
            description: "修改实现".to_string(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "完成修改".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: "diff --git a/src/lib.rs b/src/lib.rs".to_string(),
                change_report: "没有修改任何文件".to_string(),
                test_results: None,
                files_changed: vec!["src/lib.rs".to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("修改实现", vec![coder]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("src/lib.rs"));
        assert!(!report.contains("没有修改任何文件"));
    }

    #[test]
    fn fix_report_uses_current_files_changes_and_verification_in_order() {
        let coder = |files: Vec<&str>, change_report: &str| TaskNode {
            id: "task-code".to_string(),
            name: "修复登录流程".to_string(),
            description: "修复登录流程".to_string(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "登录恢复正常".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: "diff --git a/src/login.rs b/src/login.rs".to_string(),
                change_report: change_report.to_string(),
                test_results: None,
                files_changed: files.into_iter().map(str::to_string).collect(),
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let verification = |id: &str, name: &str, role: AgentRole, command: &str| TaskNode {
            id: id.to_string(),
            name: name.to_string(),
            description: name.to_string(),
            role,
            depends_on: vec!["task-code".to_string()],
            acceptance_criteria: "当前验证通过".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!("{name}通过。"),
                test_results: Some(format!(
                    "命令：{command}\n结果：通过\n退出码：0\n输出：1 passed"
                )),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let historical = coder(
            vec!["src/old_login.rs"],
            "旧尝试没有修好。\n旧 Coder 完整报告。",
        );
        let current = coder(
            vec!["src/login.rs", "tests/login_test.rs"],
            "登录提交失败时现在会显示明确提示。\n\n内部实现还包含较长的角色报告。",
        );
        let mut dag = TaskDAG::new(
            "修复登录错误",
            vec![
                current,
                verification(
                    "task-test",
                    "登录回归测试",
                    AgentRole::Tester,
                    "cargo test login_regression",
                ),
                verification(
                    "task-review",
                    "独立代码审查",
                    AgentRole::Reviewer,
                    "codepro review current patch",
                ),
            ],
        );
        dag.task_kind = Some(CodeProTaskKind::BugFix);

        let report = ResultAggregator::build_report(&dag, &[historical]);
        let headings = ["# 任务报告", "## 执行 Agent", "## 总结", "<details>"];
        let positions = headings
            .iter()
            .map(|heading| {
                assert_eq!(report.matches(heading).count(), 1, "{heading}\n{report}");
                report.find(heading).unwrap()
            })
            .collect::<Vec<_>>();

        assert!(report.starts_with("# 任务报告"));
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        let beginner = report
            .get(..positions[3])
            .expect("details position comes from a UTF-8 marker");
        let technical = report
            .get(positions[3]..)
            .expect("details position comes from a UTF-8 marker");
        assert!(beginner.contains("已经修好"));
        assert!(beginner.contains("src/login.rs"));
        assert!(beginner.contains("tests/login_test.rs"));
        assert!(beginner.contains("登录提交失败时现在会显示明确提示"));
        assert!(beginner.contains("登录回归测试"));
        assert!(beginner.contains("独立代码审查"));
        assert!(!beginner.contains("src/old_login.rs"));
        assert!(!beginner.contains("cargo test login_regression"));
        assert!(!beginner.contains("内部实现还包含较长的角色报告"));
        assert!(technical.contains("cargo test login_regression"));

        let mut unverified_dag = TaskDAG::new(
            "修复但尚未验证",
            vec![coder(
                vec!["src/login.rs"],
                "登录提交失败时现在会显示明确提示。",
            )],
        );
        unverified_dag.task_kind = Some(CodeProTaskKind::BugFix);
        let unverified = ResultAggregator::build_report(&unverified_dag, &[]);
        assert!(unverified.contains("未验证：当前修改没有验证结果"));
        assert!(unverified.contains("**未验证**：当前修改尚未经过验证"));
    }

    #[test]
    fn fix_report_uses_planned_failure_classifications() {
        let coder = || TaskNode {
            id: "task-code".to_string(),
            name: "修复接口".to_string(),
            description: "修改接口实现".to_string(),
            role: AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "接口恢复正常".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: "diff --git a/src/api.rs b/src/api.rs".to_string(),
                change_report: "接口错误处理已经更新。".to_string(),
                test_results: None,
                files_changed: vec!["src/api.rs".to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let verification = |name: &str, status: TaskStatus, evidence: Option<&str>| TaskNode {
            id: format!("task-{name}"),
            name: name.to_string(),
            description: name.to_string(),
            role: AgentRole::Tester,
            depends_on: vec!["task-code".to_string()],
            acceptance_criteria: "返回当前验证".to_string(),
            status,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!("{name}当前未通过。"),
                test_results: evidence.map(str::to_string),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let cases = [
            (
                "验证失败",
                vec![
                    coder(),
                    verification(
                        "接口回归测试",
                        TaskStatus::Done,
                        Some("命令：cargo test api\n结果：测试失败\n退出码：1\n输出：1 failed"),
                    ),
                ],
                "测试失败",
            ),
            (
                "环境阻塞",
                vec![
                    coder(),
                    verification(
                        "Python 环境检查",
                        TaskStatus::Failed,
                        Some("命令：python -m pytest\n结果：环境不可用\n退出码：1\n输出：No module named pytest"),
                    ),
                ],
                "环境问题",
            ),
            (
                "执行暂停",
                vec![
                    coder(),
                    verification("继续验证", TaskStatus::Paused, None),
                ],
                "CodePro 未完成",
            ),
            ("没有验证", vec![coder()], "未验证"),
        ];

        for (goal, tasks, classification) in cases {
            let mut dag = TaskDAG::new(goal, tasks);
            dag.task_kind = Some(CodeProTaskKind::BugFix);
            let report = ResultAggregator::build_report(&dag, &[]);
            let beginner = report.split("<details>").next().unwrap_or(&report);

            assert!(
                beginner.contains(classification),
                "missing {classification}\n{beginner}"
            );
            assert!(beginner.contains("src/api.rs"));
            assert!(beginner.contains("下一步："));
            assert!(!beginner.contains("cargo test api"));
            assert!(!beginner.contains("python -m pytest"));
        }
    }

    #[test]
    fn environment_problem_is_not_reported_as_a_project_test_failure() {
        let task = TaskNode {
            id: "task-python".to_string(),
            name: "运行项目测试".to_string(),
            description: "运行项目测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report:
                    "结论：环境不可用，当前电脑没有可用的 Python，项目依赖也没有安装完整。"
                        .to_string(),
                test_results: Some(
                    "已执行 2 条可核验命令：
- 命令：{\"command\":\"python --version\"}
  结果：检查失败
  退出码：1
  输出：
系统找不到文件 C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe。
- 命令：{\"command\":\"python _import_test.py\"}
  结果：测试失败
  退出码：1
  输出：
No module named 'requests'"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: Some(crate::agents::task_dag::TaskUsage {
                    input_tokens: 100,
                    output_tokens: 20,
                    total_tokens: 120,
                    cost_usd: None,
                }),
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("分析测试项目 Bug", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);
        let counts = ResultAggregator::classification_counts(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        assert!(!report.contains("检查完成（环境受限）"));
        assert!(!report.contains("CodePro 未完成：1 项"));
        assert!(report.contains("已完成当前环境能够执行的检查"));
        assert!(report.contains("### 接下来需要你做什么"));
        assert!(report.contains("缺少可用的 Python 或项目依赖"));
        assert!(!report.contains("测试失败：0 项"));
        assert!(!report.contains("**测试失败 ·"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(!beginner_summary.contains("python --version"));
        assert!(!report.contains("Token"));
        assert!(!report.contains("Agent 补充说明"));
        assert_eq!(counts.environment_problem, 1);
        assert_eq!(counts.test_failure, 0);
        assert_eq!(counts.confirmed_bug, 0);
    }

    #[test]
    fn structured_confirmed_findings_are_shown_before_environment_limitations() {
        let finding_task = TaskNode {
            id: "task-audit".to_string(),
            name: "审查 Electron 安全边界".to_string(),
            description: "检查渲染器与本地能力边界".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告可定位、可复现的问题".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：确认一个高风险问题。\n\
                    已确认问题：\n\
                    - [严重] LLM 输出可触发本地脚本执行 | thinkpath/main.js:12、index.html:588 | nodeIntegration 开启且模型输出进入 innerHTML | 违反：渲染器不得执行不可信模型输出的安全边界\n\
                    验证：已完成静态数据流检查。\n\
                    未运行：真实 API 调用需要密钥。"
                    .to_string(),
                test_results: Some(
                    "命令：rg -n \"nodeIntegration|innerHTML\" thinkpath\n结果：通过\n退出码：0"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let environment_task = TaskNode {
            id: "task-build".to_string(),
            name: "运行完整构建".to_string(),
            description: "验证 Electron 打包".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "记录真实构建结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：构建依赖未安装，暂时无法运行。".to_string(),
                test_results: Some(
                    "命令：npm run build\n结果：环境不可用\n退出码：1\n输出：electron-builder is not recognized"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let report = ResultAggregator::build_report(
            &TaskDAG::new("分析项目哪里有 Bug", vec![finding_task, environment_task]),
            &[],
        );

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("## 执行 Agent"));
        assert!(report.contains("LLM 输出可触发本地脚本执行"));
        assert!(report.contains("thinkpath/main.js:12"));
        assert!(report.contains("确认 Bug：1 项"));
        assert!(report.contains("### 接下来需要你做什么"));
        assert!(!report.contains("检查完成（环境受限）"));
    }

    #[test]
    fn later_project_pytest_execution_resolves_earlier_python_probe_failure() {
        let static_audit = TaskNode {
            id: "task-audit".to_string(),
            name: "项目静态分析与 Bug 审查".to_string(),
            description: "读取源码并记录候选问题".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告静态分析与未运行场景".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：静态审查已经完成。\n\
                    已确认问题：\n\
                    - [中] 参数类型缺少校验 | src/calculator.py:30-33 | 静态阅读发现\n\
                    未运行：pytest，因为默认 Python 不可用。"
                    .to_string(),
                test_results: Some(
                    "命令：python3 -m pytest tests/ -q\n\
                     结果：环境不可用\n\
                     退出码：1\n\
                     输出：WindowsApps\\python3.exe 不可用"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let verification = TaskNode {
            id: "task-verify".to_string(),
            name: "验证分析结果并执行冒烟测试".to_string(),
            description: "使用项目虚拟环境执行 pytest".to_string(),
            role: AgentRole::Tester,
            depends_on: vec!["task-audit".to_string()],
            acceptance_criteria: "报告完整测试统计".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：项目 .venv 可用，现有测试集 148/149 通过，1 个测试失败。"
                    .to_string(),
                test_results: Some(
                    "命令：C:\\project\\.venv\\Scripts\\python.exe -m pytest tests/ -q\n\
                     结果：测试失败\n\
                     退出码：1\n\
                     输出：148 passed, 1 failed"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let report = ResultAggregator::build_report(
            &TaskDAG::new("分析测试项目哪里有 Bug", vec![static_audit, verification]),
            &[],
        );

        assert!(!report.contains("电脑没有找到可用的 Python"));
        assert!(!report.contains("CodePro 未完成：1 项"));
        assert!(!report.contains("CodePro 未完成：0 项"));
        assert!(report.contains("测试失败：1 项"));
        assert!(report.contains("测试用例：148 通过，1 失败"));
        assert!(report.contains("已找到项目 Python 环境并成功启动 pytest"));
    }

    #[test]
    fn finding_without_contract_violation_is_a_risk_not_a_confirmed_bug() {
        let task = TaskNode {
            id: "task-audit".to_string(),
            name: "静态审查".to_string(),
            description: "检查输入校验".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "区分 Bug 与风险".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：发现一个候选问题。\n\
                    已确认问题：\n\
                    - [中] divide 不接受字符串参数 | src/calculator.py:30-33 | 传入字符串抛出 TypeError\n\
                    验证：行为已复现。"
                    .to_string(),
                test_results: Some(
                    "命令：pytest tests/reproduction.py -q\n结果：通过\n退出码：0\n输出：1 passed"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let report = ResultAggregator::build_report(&TaskDAG::new("分析项目 Bug", vec![task]), &[]);

        assert!(report.contains("**未验证**"));
        assert!(report.contains("RISK-001"));
        assert!(report.contains("divide 不接受字符串参数"));
        assert!(!report.contains("BUG-001"));
        assert!(!report.contains("确认 Bug：0 项"));
        assert!(report.contains("未验证：1 项"));
    }

    #[test]
    fn role_finding_parser_accepts_new_and_legacy_headings() {
        let report_for = |heading: &str, contract: &str| {
            let task = TaskNode {
                id: format!("task-{heading}"),
                name: "核验接口".to_string(),
                description: "核验接口".to_string(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "兼容角色报告格式".to_string(),
                status: TaskStatus::Done,
                output: Some(crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: format!(
                        "结论：完成。\n{heading}：\n- [高] 返回值不一致 | src/api.rs:20 | 已观察行为{contract}\n验证：已执行"
                    ),
                    test_results: Some(
                        "命令：cargo test api\n结果：通过\n退出码：0\n输出：1 passed"
                            .to_string(),
                    ),
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            };
            ResultAggregator::build_report(&TaskDAG::new("核验接口", vec![task]), &[])
        };

        for heading in ["已确认问题", "确认 Bug"] {
            let report = report_for(heading, " | 违反：公开接口约定");
            assert!(report.contains("确认 Bug：1 项"), "{heading}\n{report}");
            assert!(report.contains("BUG-001"), "{heading}\n{report}");
        }
        for heading in ["待确认风险", "未验证"] {
            let report = report_for(heading, "");
            assert!(!report.contains("确认 Bug：0 项"), "{heading}\n{report}");
            assert!(report.contains("未验证：1 项"), "{heading}\n{report}");
            assert!(report.contains("RISK-001"), "{heading}\n{report}");
        }
    }

    #[test]
    fn contracted_findings_are_deduplicated_and_receive_stable_bug_ids() {
        let make_task = |id: &str, title: &str| {
            TaskNode {
            id: id.to_string(),
            name: title.to_string(),
            description: "核验文档与仓库状态".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "提供合同和复现证据".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!(
                    "结论：确认文档错误。\n已确认问题：\n\
                     - [低] {title} | dependency_check_report.md:2 | requirements.txt 实际存在 | 违反：报告声称该文件不存在"
                ),
                test_results: Some(
                    "命令：dir requirements.txt\n结果：通过\n退出码：0\n输出：requirements.txt"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        }
        };
        let report = ResultAggregator::build_report(
            &TaskDAG::new(
                "检查文档",
                vec![
                    make_task("task-1", "依赖报告与项目状态不一致"),
                    make_task("task-2", "依赖检查文档结论错误"),
                ],
            ),
            &[],
        );

        assert!(report.contains("## 执行 Agent"));
        assert!(report.contains("BUG-001"));
        assert!(!report.contains("BUG-002"));
        assert!(report.contains("确认 Bug：1 项"));
    }

    #[test]
    fn later_contract_evidence_upgrades_a_duplicate_risk_to_a_confirmed_bug() {
        let make_task = |id: &str, finding: &str| TaskNode {
            id: id.to_string(),
            name: id.to_string(),
            description: "核验同一问题".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "根据合同证据分类".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!("结论：完成核验。\n已确认问题：\n{finding}"),
                test_results: Some(
                    "命令：pytest tests/test_api.py -q\n结果：测试失败\n退出码：1\n输出：1 failed"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let risk = make_task(
            "static-audit",
            "- [中] 返回值可能不正确 | src/api.py:20 | 静态阅读发现",
        );
        let confirmed = make_task(
            "contract-check",
            "- [高] 返回值违反公开接口 | src/api.py:20 | 现有测试稳定失败 | 违反：类型声明要求返回 Result",
        );
        let report =
            ResultAggregator::build_report(&TaskDAG::new("核验接口", vec![risk, confirmed]), &[]);

        assert!(report.contains("BUG-001"));
        assert!(report.contains("返回值违反公开接口"));
        assert!(!report.contains("RISK-001"));
        assert!(report.contains("确认 Bug：1 项"));
        assert!(!report.contains("未验证：0 项"));
    }

    #[test]
    fn successful_test_after_python_probe_failure_is_counted_as_passed() {
        let task = TaskNode {
            id: "task-smoke".to_string(),
            name: "运行现有冒烟测试".to_string(),
            description: "运行项目冒烟测试".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告测试结果".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：46 项冒烟测试全部通过。".to_string(),
                test_results: Some(
                    "已执行 2 条可核验命令：
- 命令：{\"command\":\"python --version\"}
  结果：环境不可用
  退出码：1
  输出：
系统找不到文件 C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe。
- 命令：{\"command\":\"C:\\\\uv\\\\python.exe _smoke_test.py\"}
  结果：通过
  退出码：0
  输出：
Total: 46, Pass: 46, Fail: 0"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("分析测试项目", vec![task]);

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("- 已通过：1 项"));
        assert!(!report.contains("环境问题：0 项"));
        assert!(!report.contains("未验证：0 项"));
        assert!(!report.contains("测试环境没有准备好"));
    }

    #[test]
    fn report_does_not_invent_a_project_bug_from_environment_and_command_failures() {
        let make_task =
            |id: &str, name: &str, status: TaskStatus, evidence: Option<&str>| TaskNode {
                id: id.to_string(),
                name: name.to_string(),
                description: name.to_string(),
                role: AgentRole::Tester,
                depends_on: vec![],
                acceptance_criteria: "报告结果".to_string(),
                status,
                output: evidence.map(|test_results| crate::agents::task_dag::TaskOutput {
                    patch: String::new(),
                    change_report: "检查完成".to_string(),
                    test_results: Some(test_results.to_string()),
                    files_changed: vec![],
                    validation_not_run: None,
                    usage: None,
                }),
                retry_count: 0,
            };
        let dag = TaskDAG::new(
            "检查项目",
            vec![
                make_task(
                    "task-env",
                    "运行导入检查",
                    TaskStatus::Done,
                    Some("结果：环境不可用\n输出：No module named 'requests'"),
                ),
                make_task(
                    "task-command",
                    "启动测试命令",
                    TaskStatus::Done,
                    Some("结果：命令执行失败\n输出：CMD 不支持将 UNC 路径作为当前目录"),
                ),
                make_task("task-agent", "汇总结果", TaskStatus::Failed, None),
            ],
        );

        let report = ResultAggregator::build_report(&dag, &[]);

        assert!(!report.contains("测试失败：0 项"));
        assert!(report.contains("环境问题：1 项"));
        assert!(report.contains("CodePro 未完成：2 项"));
        assert!(report.contains("本次没有得到完整的项目检查结果"));
        let beginner_summary = report.split("<details>").next().unwrap_or(&report);
        assert!(!beginner_summary.contains("No module named"));
        assert!(!beginner_summary.contains("UNC 路径"));
    }

    #[test]
    fn failed_task_with_test_evidence_is_not_also_an_agent_execution_failure() {
        let task = TaskNode {
            id: "task-test".to_string(),
            name: "运行项目测试".to_string(),
            description: "执行 pytest".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "报告真实测试结果".to_string(),
            status: TaskStatus::Failed,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：项目测试有 1 项失败。".to_string(),
                test_results: Some(
                    "命令：python -m pytest -q\n结果：测试失败\n退出码：1\n输出：1 failed"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(&TaskDAG::new("运行项目测试", vec![task]), &[]);

        assert!(report.contains("测试失败：1 项"));
        assert!(!report.contains("CodePro 未完成：0 项"));
        assert!(!report.contains("### CodePro 未完成"));
    }

    #[test]
    fn failed_task_with_environment_evidence_is_not_also_an_agent_execution_failure() {
        let task = TaskNode {
            id: "task-environment".to_string(),
            name: "运行导入检查".to_string(),
            description: "执行 Python 导入检查".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "区分环境问题".to_string(),
            status: TaskStatus::Failed,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：环境不可用。".to_string(),
                test_results: Some(
                    "命令：python _import_test.py\n结果：环境不可用\n退出码：1\n输出：No module named 'requests'"
                        .to_string(),
                ),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(&TaskDAG::new("运行导入检查", vec![task]), &[]);

        assert!(report.contains("环境问题：1 项"));
        assert!(!report.contains("CodePro 未完成：0 项"));
        assert!(!report.contains("### CodePro 未完成"));
        assert!(!report.contains("测试失败：0 项"));
    }

    #[test]
    fn contract_claim_without_host_verification_stays_a_risk() {
        let task = TaskNode {
            id: "task-candidate".to_string(),
            name: "静态候选问题".to_string(),
            description: "记录候选问题".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "没有证据时不得确认".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "结论：发现候选问题。\n\
                    已确认问题：\n\
                    - [高] 返回值违反公开接口 | src/api.py:20 | 仅根据源码猜测 | 违反：类型声明要求返回 Result"
                    .to_string(),
                test_results: None,
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(&TaskDAG::new("检查接口", vec![task]), &[]);

        assert!(!report.contains("确认 Bug：0 项"));
        assert!(report.contains("未验证：1 项"));
        assert!(report.contains("RISK-001"));
        assert!(!report.contains("## 已确认的 Bug"));
    }

    #[test]
    fn historical_success_does_not_complete_a_current_task_without_evidence() {
        let historical = TaskNode {
            id: "task-current".to_string(),
            name: "运行完整测试".to_string(),
            description: "验证项目".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "记录当前证据".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: "旧运行通过".to_string(),
                test_results: Some(
                    "命令：{\"command\":\"cargo test -p app\"}\n结果：通过\n退出码：0".to_string(),
                ),
                files_changed: vec!["src/old.rs".to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let current = TaskNode {
            output: None,
            ..historical.clone()
        };

        let report =
            ResultAggregator::build_report(&TaskDAG::new("验证项目", vec![current]), &[historical]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("CodePro 未完成：1 项"));
        assert!(report.contains("### 接下来需要你做什么"));
        assert!(report.contains("运行完整测试"));
        assert!(report.contains("任务没有返回可核验结果"));
        assert!(!report.contains("已通过：1 项"));
        assert!(!report.contains("src/old.rs"));
    }

    #[test]
    fn failed_task_without_output_still_produces_an_incomplete_report() {
        let task = TaskNode {
            id: "task-failed".to_string(),
            name: "执行无法启动的检查".to_string(),
            description: "运行检查".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "返回证据".to_string(),
            status: TaskStatus::Failed,
            output: None,
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(&TaskDAG::new("检查项目", vec![task]), &[]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("执行无法启动的检查"));
        assert!(report.contains("任务没有返回可核验结果"));
    }

    #[test]
    fn current_success_is_not_overridden_by_a_historical_failure() {
        let make_task = |status, result: &str, exit_code: i32| {
            TaskNode {
            id: "task-retry".to_string(),
            name: "运行重试检查".to_string(),
            description: "验证重试结果".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "最后一次执行为当前结果".to_string(),
            status,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: format!("当前结果：{result}"),
                test_results: Some(format!(
                    "命令：{{\"command\":\"cargo test -p app\"}}\n结果：{result}\n退出码：{exit_code}"
                )),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        }
        };
        let historical = make_task(TaskStatus::Failed, "测试失败", 1);
        let current = make_task(TaskStatus::Done, "通过", 0);

        let report =
            ResultAggregator::build_report(&TaskDAG::new("验证项目", vec![current]), &[historical]);

        assert!(report.contains("# 任务报告"));
        assert!(report.contains("已通过：1 项"));
        assert!(!report.contains("测试失败：0 项"));
        assert!(!report.contains("**测试失败 ·"));
    }

    #[test]
    fn retry_history_is_folded_below_the_current_success() {
        let make_task = |status, result: &str, exit_code: i32| {
            TaskNode {
            id: "task-history".to_string(),
            name: "运行历史检查".to_string(),
            description: "验证重试历史".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "当前成功并保留失败历史".to_string(),
            status,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: String::new(),
                test_results: Some(format!(
                    "命令：{{\"command\":\"cargo test -p app\"}}\n结果：{result}\n退出码：{exit_code}"
                )),
                files_changed: vec![],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        }
        };
        let historical = make_task(TaskStatus::Failed, "测试失败", 1);
        let current = make_task(TaskStatus::Done, "通过", 0);

        let report =
            ResultAggregator::build_report(&TaskDAG::new("验证项目", vec![current]), &[historical]);
        let (beginner, technical) = report.split_once("<details>").expect("technical details");

        assert!(beginner.contains("已通过：1 项"));
        assert!(!beginner.contains("结果：测试失败"));
        assert!(technical.contains("当前结果"));
        assert!(technical.contains("结果：通过"));
        assert!(technical.contains("重试历史（仅供参考）"));
        assert_eq!(technical.matches("结果：测试失败").count(), 1);
    }

    #[test]
    fn current_files_and_reviewer_summary_exclude_history_only_values() {
        let make_review = |report: &str, file: &str| TaskNode {
            id: "task-review".to_string(),
            name: "独立审查".to_string(),
            description: "审查当前修改".to_string(),
            role: AgentRole::Reviewer,
            depends_on: vec![],
            acceptance_criteria: "报告当前审查结论".to_string(),
            status: TaskStatus::Done,
            output: Some(crate::agents::task_dag::TaskOutput {
                patch: String::new(),
                change_report: report.to_string(),
                test_results: None,
                files_changed: vec![file.to_string()],
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let historical = make_review("旧审查：未通过", "src/old.rs");
        let current = make_review("当前审查：通过", "src/current.rs");

        let report =
            ResultAggregator::build_report(&TaskDAG::new("审查项目", vec![current]), &[historical]);

        assert!(report.starts_with("# 任务报告"));
        assert!(report.contains("## 执行 Agent"));
        assert!(report.contains("src/current.rs"));
        assert!(report.contains("当前审查：通过"));
        assert!(!report.contains("src/old.rs"));
        assert!(!report.contains("旧审查：未通过"));
    }

    #[test]
    fn outputless_failed_task_has_an_explicit_technical_entry() {
        let task = TaskNode {
            id: "task-no-output".to_string(),
            name: "无法执行的验证".to_string(),
            description: "尝试运行验证".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![],
            acceptance_criteria: "返回验证证据".to_string(),
            status: TaskStatus::Failed,
            output: None,
            retry_count: 0,
        };

        let report = ResultAggregator::build_report(&TaskDAG::new("验证项目", vec![task]), &[]);
        let technical = report
            .split_once("<details>")
            .map(|(_, details)| details)
            .expect("technical details");

        assert!(technical.contains("task-no-output · 无法执行的验证"));
        assert!(technical.contains("当前证据：无"));
    }
}
