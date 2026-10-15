use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

use crate::agents::{
    agent_role::{CodeProRiskAssessment, CodeProRiskReason, CodeProRiskTier},
    codepro_report::sanitize_report_inline,
    codepro_run_result::{CodeProRunResult, VerificationOutcome},
    codepro_state_store::CodeProRunStatus,
    control_plane::{ConvergenceAssessment, ConvergenceStatus},
    task_dag::VerificationEvidenceV1,
    user_report::{render_user_report_v1, UserAgentResultV1, UserReportV1},
};

/// Render an execution interruption from its actual error and recorded receipts.
/// This message is not a completion proposal or permission to replay effects.
/// Provider error exits call this directly; completion gaps use the separate
/// report_blocked handoff, not the legacy incomplete renderer below.
pub(crate) fn render_main_agent_provider_error(
    error: &goose_providers::errors::ProviderError,
    evidence: &super::tool_task::MainAgentActionEvidenceV1,
    chinese: bool,
) -> String {
    use goose_providers::errors::ProviderError;
    let (reason, next) = match (chinese, error) {
        (true, ProviderError::RateLimitExceeded { .. }) => (
            "模型服务暂时限制了请求频率，这轮工作已暂停，还没有完成交付。",
            "请稍后继续此任务。我会先核对现有文件和未完成步骤，再接着处理；不会直接重做结果不确定的操作。",
        ),
        (true, ProviderError::Authentication(_)) => (
            "模型服务未通过身份验证，这轮工作已暂停，还没有完成交付。",
            "请检查模型服务的登录或密钥设置，再继续此任务。已有操作不会自动重做。",
        ),
        (true, ProviderError::CreditsExhausted { .. }) => (
            "模型服务可用额度已耗尽，这轮工作已暂停，还没有完成交付。",
            "请检查模型服务额度后继续此任务。已有操作不会自动重做。",
        ),
        (true, _) => (
            "模型服务未能继续响应，这轮工作已暂停，还没有完成交付。",
            "请检查模型服务状态后继续此任务。我会先核对已有结果和剩余工作，不会直接重做结果不确定的操作。",
        ),
        (false, ProviderError::RateLimitExceeded { .. }) => (
            "The model service rate limit was reached. Work is paused, not delivered.",
            "Continue this task later. I will check existing files and unfinished work first, without blindly repeating uncertain operations.",
        ),
        (false, ProviderError::Authentication(_)) => (
            "The model service rejected authentication. Work is paused, not delivered.",
            "Check the model service credentials before continuing. Existing operations will not be automatically replayed.",
        ),
        (false, ProviderError::CreditsExhausted { .. }) => (
            "The model service has no remaining credits. Work is paused, not delivered.",
            "Check the service credits before continuing. Existing operations will not be automatically replayed.",
        ),
        (false, _) => (
            "The model service could not continue. Work is paused, not delivered.",
            "Check the service status before continuing. I will check existing results before taking further action.",
        ),
    };
    let mut report = reason.to_string();
    let paths: std::collections::BTreeSet<_> = evidence
        .action_index
        .values()
        .flat_map(|action| action.changed_paths.iter())
        .collect();
    if !paths.is_empty() {
        report.push_str(if chinese {
            "\n\n已记录以下文件改动；暂停不会自动撤销它们，但这些记录不代表功能已经验收："
        } else {
            "\n\nRecorded file changes are not automatically undone by this pause; they do not establish functional acceptance:"
        });
        for path in paths.iter().take(5) {
            report.push_str(&format!("\n- `{}`", sanitize_report_inline(path)));
        }
        if paths.len() > 5 {
            report.push_str(if chinese {
                "\n其余改动可展开操作记录查看。"
            } else {
                "\nOther changes are available in the operation details."
            });
        }
    }
    report.push_str(&format!("\n\n{next}"));
    // Reuse the persisted-evidence redactor; service errors can contain secrets.
    // Keep diagnostics in the saved message without making them the headline.
    let diagnostic = super::codepro_event_log::redact_persisted_text(error.to_string());
    let mut bounded: String = diagnostic.chars().take(4000).collect();
    if bounded.len() < diagnostic.len() {
        bounded.push_str("\n[TRUNCATED]");
    }
    let diagnostic = sanitize_report_inline(&bounded);
    let fence = "`".repeat(
        diagnostic
            .split(|character| character != '`')
            .map(str::len)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(3),
    );
    let title = if chinese {
        "查看运行记录"
    } else {
        "Technical details"
    };
    report.push_str(&format!(
        "\n\n<details>\n<summary>{title}</summary>\n\n{fence}text\n{diagnostic}\n{fence}\n\n</details>"
    ));
    report
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CodeProTerminalOutcome {
    Completed,
    Skipped,
    Partial,
    Paused,
    WaitingForUser,
    Cancelled,
    PlanningFailed,
    SchedulingFailed,
    ReviewFailed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReportRecoveryAction {
    None,
    RetryPlanning,
    ContinueCheckpoint,
    AskUser,
    RetryValidation,
    RetryReview,
    SelectProjectDirectory,
    ManualReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReportEvidenceKind {
    File,
    Verification,
    Review,
    Limitation,
    RunState,
    Diagnostic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReportEvidence {
    pub id: String,
    pub kind: ReportEvidenceKind,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VerificationVerdict {
    Passed,
    Skipped,
    Failed,
    Unverified,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct VerificationSummary {
    pub task_id: String,
    pub verdict: VerificationVerdict,
    pub command: Option<String>,
    pub exit_code: Option<i32>,
    pub evidence_ref: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ClassificationCounts {
    pub confirmed_bug: u32,
    pub test_failure: u32,
    pub environment_problem: u32,
    pub codepro_incomplete: u32,
    pub unverified: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CodeProTerminalReportPayload {
    pub outcome: CodeProTerminalOutcome,
    pub classification_counts: ClassificationCounts,
    pub changed_files: Vec<String>,
    pub verification_summary: Vec<VerificationSummary>,
    pub limitations: Vec<String>,
    pub recovery_action: ReportRecoveryAction,
    #[serde(default)]
    pub risk_tier: Option<CodeProRiskTier>,
    #[serde(default)]
    pub risk_reasons: Vec<CodeProRiskReason>,
    #[serde(default)]
    pub review_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CodeProReportFacts {
    pub outcome: CodeProTerminalOutcome,
    pub task_kind: String,
    pub risk_tier: CodeProRiskTier,
    pub risk_reasons: Vec<CodeProRiskReason>,
    pub review_required: bool,
    pub completion_allowed: bool,
    pub locale: String,
    pub trusted_project_root: Option<PathBuf>,
    pub changed_files: Vec<String>,
    pub verification_summary: Vec<VerificationSummary>,
    pub reviewer_approved: bool,
    pub limitations: Vec<String>,
    pub recovery_action: ReportRecoveryAction,
    pub classification_counts: ClassificationCounts,
    pub evidence: BTreeMap<String, ReportEvidence>,
    pub agent_results: Vec<UserAgentResultV1>,
}

impl CodeProReportFacts {
    pub(crate) fn add_limitation(&mut self, limitation: String) {
        if self.limitations.contains(&limitation) {
            return;
        }
        self.limitations.push(limitation.clone());
        let id = format!("limitation-{}", self.limitations.len());
        self.evidence.insert(
            id.clone(),
            ReportEvidence {
                id,
                kind: ReportEvidenceKind::Limitation,
                label: "limitation".to_string(),
                value: limitation,
            },
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportDraftItem {
    pub text: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportDraftV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    pub summary: String,
    #[serde(default)]
    pub changes: Vec<ReportDraftItem>,
    #[serde(default)]
    pub verification: Vec<ReportDraftItem>,
    #[serde(default)]
    pub limitations: Vec<ReportDraftItem>,
    #[serde(default)]
    pub next_step: Option<ReportDraftItem>,
}

fn deserialize_schema_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if version == 1 {
        Ok(version)
    } else {
        Err(serde::de::Error::custom("schema_version must be 1"))
    }
}

pub(crate) struct ReportFactsInput<'a> {
    pub requested_outcome: Option<CodeProTerminalOutcome>,
    pub run_status: CodeProRunStatus,
    pub convergence: Option<&'a ConvergenceAssessment>,
    pub run: &'a CodeProRunResult,
    pub trusted_project_root: Option<&'a Path>,
    pub task_kind: &'a str,
    pub risk_assessment: &'a CodeProRiskAssessment,
    pub reviewer_approved: bool,
    pub limitations: Vec<String>,
    pub recovery_action: ReportRecoveryAction,
}

fn display_command_from_evidence(evidence: &str) -> Option<String> {
    evidence.lines().find_map(|line| {
        let command = line
            .trim()
            .trim_start_matches("- ")
            .trim()
            .strip_prefix("命令：")?
            .trim();
        (!command.is_empty() && command != "（未执行）").then(|| command.to_string())
    })
}

pub(crate) fn final_verification_by_task(run: &CodeProRunResult) -> Vec<VerificationSummary> {
    let mut groups_by_task = BTreeMap::<&str, Vec<_>>::new();
    for group in &run.verification_groups {
        groups_by_task
            .entry(group.task_id.as_str())
            .or_default()
            .push(group);
    }

    let mut summaries = groups_by_task
        .into_iter()
        .enumerate()
        .map(|(index, (task_id, groups))| {
            let has_pass = groups
                .iter()
                .any(|group| matches!(group.current.outcome, VerificationOutcome::Passed));
            let has_failure = groups.iter().any(|group| {
                matches!(
                    group.current.outcome,
                    VerificationOutcome::TestFailed
                        | VerificationOutcome::CheckFailed
                        | VerificationOutcome::CommandFailed
                )
            });
            let has_unavailable = groups.iter().any(|group| {
                matches!(
                    group.current.outcome,
                    VerificationOutcome::EnvironmentUnavailable | VerificationOutcome::NoTests
                )
            });
            let has_unknown = groups.iter().any(|group| {
                matches!(
                    group.current.outcome,
                    VerificationOutcome::Unknown | VerificationOutcome::Completed
                )
            });
            let verdict = match (has_pass, has_failure, has_unavailable, has_unknown) {
                (true, false, false, false) => VerificationVerdict::Passed,
                (false, true, false, false) => VerificationVerdict::Failed,
                (false, false, true, false) => VerificationVerdict::Unavailable,
                _ => VerificationVerdict::Unverified,
            };
            let representative = match verdict {
                VerificationVerdict::Passed
                    if groups.iter().all(|group| {
                        matches!(group.current.outcome, VerificationOutcome::Passed)
                    }) =>
                {
                    groups.last().copied()
                }
                VerificationVerdict::Failed
                    if groups.iter().all(|group| {
                        matches!(
                            group.current.outcome,
                            VerificationOutcome::TestFailed
                                | VerificationOutcome::CheckFailed
                                | VerificationOutcome::CommandFailed
                        )
                    }) =>
                {
                    groups.last().copied()
                }
                VerificationVerdict::Unavailable
                    if groups.iter().all(|group| {
                        matches!(
                            group.current.outcome,
                            VerificationOutcome::EnvironmentUnavailable
                                | VerificationOutcome::NoTests
                        )
                    }) =>
                {
                    groups.last().copied()
                }
                _ => None,
            };
            let command = representative.and_then(|group| {
                if group.key.starts_with("assertion:") {
                    serde_json::from_str::<VerificationEvidenceV1>(&group.current.evidence)
                        .ok()
                        .and_then(|evidence| evidence.repair_context)
                        .map(|context| context.command)
                        .filter(|command| !command.trim().is_empty())
                } else {
                    display_command_from_evidence(&group.current.evidence)
                        .or_else(|| Some(group.key.clone()))
                }
            });
            VerificationSummary {
                task_id: task_id.to_string(),
                verdict,
                command,
                exit_code: representative.and_then(|group| group.current.exit_code),
                evidence_ref: format!("verify-{}", index + 1),
            }
        })
        .collect::<Vec<_>>();

    for task in &run.tasks {
        if matches!(
            task.status,
            crate::agents::task_dag::TaskStatus::Pending
                | crate::agents::task_dag::TaskStatus::Ready
                | crate::agents::task_dag::TaskStatus::Running
                | crate::agents::task_dag::TaskStatus::Paused
        ) {
            if let Some(summary) = summaries
                .iter_mut()
                .find(|summary| summary.task_id == task.id)
            {
                summary.verdict = VerificationVerdict::Unverified;
                summary.exit_code = None;
            }
        }
        let skipped_dynamic_validation = task.status
            == crate::agents::task_dag::TaskStatus::Skipped
            && task.current_output.as_ref().is_some_and(|output| {
                output.validation_not_run.is_some()
                    || output
                        .test_results
                        .as_deref()
                        .is_some_and(|evidence| evidence.contains("result:NOT_RUN"))
            });
        if skipped_dynamic_validation {
            let not_run_command = task.current_output.as_ref().and_then(|output| {
                if let Some(evidence) = output.validation_not_run.as_ref() {
                    evidence.command.clone()
                } else {
                    output
                        .test_results
                        .as_deref()
                        .and_then(display_command_from_evidence)
                }
            });
            if let Some(summary) = summaries
                .iter_mut()
                .find(|summary| summary.task_id == task.id)
            {
                summary.verdict = VerificationVerdict::Skipped;
                summary.command = not_run_command;
                summary.exit_code = None;
            } else {
                summaries.push(VerificationSummary {
                    task_id: task.id.clone(),
                    verdict: VerificationVerdict::Skipped,
                    command: not_run_command,
                    exit_code: None,
                    evidence_ref: format!("verify-{}", summaries.len() + 1),
                });
            }
        }
    }

    summaries
}

pub(crate) fn build_report_facts(input: ReportFactsInput<'_>) -> CodeProReportFacts {
    let requested_or_status_outcome = input.requested_outcome.unwrap_or_else(|| {
        if let Some(assessment) = input.convergence {
            match assessment.status {
                ConvergenceStatus::Eligible => outcome_from_run_status(input.run_status),
                ConvergenceStatus::InProgress => CodeProTerminalOutcome::Partial,
                ConvergenceStatus::Blocked => CodeProTerminalOutcome::Failed,
            }
        } else {
            outcome_from_run_status(input.run_status)
        }
    });
    let candidate_outcome = match input.convergence.map(|assessment| assessment.status) {
        Some(ConvergenceStatus::Blocked) => CodeProTerminalOutcome::Failed,
        Some(ConvergenceStatus::InProgress)
            if requested_or_status_outcome == CodeProTerminalOutcome::Completed =>
        {
            CodeProTerminalOutcome::Partial
        }
        _ => requested_or_status_outcome,
    };

    let configured_root = input
        .trusted_project_root
        .filter(|root| root.parent().is_some());
    let trusted_project_root = configured_root
        .and_then(|root| root.canonicalize().ok())
        .map(normalize_canonical_report_path);
    let mut limitations = input.limitations;
    let mut changed_files = Vec::new();
    let mut rejected_file = false;
    for file in &input.run.current_files {
        match trusted_relative_path(configured_root, file)
            .or_else(|| trusted_relative_path(trusted_project_root.as_deref(), file))
        {
            Some(relative) if !changed_files.contains(&relative) => changed_files.push(relative),
            Some(_) => {}
            None => rejected_file = true,
        }
    }
    if rejected_file
        && !limitations
            .iter()
            .any(|item| item == "out_of_workspace_operation")
    {
        limitations.push("out_of_workspace_operation".to_string());
    }

    let verification_summary = final_verification_by_task(input.run);
    let review_required = input.risk_assessment.review_required();
    let review_gate_satisfied = !review_required || input.reviewer_approved;
    let convergence_gate_satisfied = input
        .convergence
        .is_none_or(|assessment| assessment.status == ConvergenceStatus::Eligible);
    let verification_gate_satisfied = verification_summary
        .iter()
        .filter(|verification| !input.run.diagnostic_tasks.contains(&verification.task_id))
        .all(|verification| verification.verdict == VerificationVerdict::Passed)
        && input.run.tasks.iter().all(|task| {
            task.status == crate::agents::task_dag::TaskStatus::Skipped
                || task.role != crate::agents::agent_role::AgentRole::Tester
                || (task.status == crate::agents::task_dag::TaskStatus::Done
                    && task.has_current_verification)
        });
    let completion_allowed = candidate_outcome == CodeProTerminalOutcome::Completed
        && review_gate_satisfied
        && convergence_gate_satisfied
        && verification_gate_satisfied;
    let outcome = if candidate_outcome == CodeProTerminalOutcome::Completed && !completion_allowed {
        CodeProTerminalOutcome::Failed
    } else {
        candidate_outcome
    };
    let mut classification_counts = ClassificationCounts::default();
    for verification in &verification_summary {
        match verification.verdict {
            VerificationVerdict::Passed | VerificationVerdict::Skipped => {}
            VerificationVerdict::Failed => classification_counts.test_failure += 1,
            VerificationVerdict::Unavailable => classification_counts.environment_problem += 1,
            VerificationVerdict::Unverified => classification_counts.unverified += 1,
        }
    }
    if !matches!(
        outcome,
        CodeProTerminalOutcome::Completed | CodeProTerminalOutcome::Skipped
    ) {
        classification_counts.codepro_incomplete = 1;
    }

    let mut evidence = BTreeMap::new();
    evidence.insert(
        "run-state".to_string(),
        ReportEvidence {
            id: "run-state".to_string(),
            kind: ReportEvidenceKind::RunState,
            label: "outcome".to_string(),
            value: serde_json::to_value(outcome)
                .expect("terminal outcome serializes")
                .as_str()
                .unwrap_or("failed")
                .to_string(),
        },
    );
    for (index, file) in changed_files.iter().enumerate() {
        let id = format!("file-{}", index + 1);
        evidence.insert(
            id.clone(),
            ReportEvidence {
                id,
                kind: ReportEvidenceKind::File,
                label: "changed_file".to_string(),
                value: file.clone(),
            },
        );
    }
    for verification in &verification_summary {
        evidence.insert(
            verification.evidence_ref.clone(),
            ReportEvidence {
                id: verification.evidence_ref.clone(),
                kind: ReportEvidenceKind::Verification,
                label: verification.task_id.clone(),
                value: format!("{:?}", verification.verdict).to_ascii_lowercase(),
            },
        );
    }
    for (index, limitation) in limitations.iter().enumerate() {
        let id = format!("limitation-{}", index + 1);
        evidence.insert(
            id.clone(),
            ReportEvidence {
                id,
                kind: ReportEvidenceKind::Limitation,
                label: "limitation".to_string(),
                value: limitation.clone(),
            },
        );
    }
    if input.reviewer_approved {
        evidence.insert(
            "review-1".to_string(),
            ReportEvidence {
                id: "review-1".to_string(),
                kind: ReportEvidenceKind::Review,
                label: "reviewer".to_string(),
                value: "approved".to_string(),
            },
        );
    }

    let agent_results = agent_results_from_run(input.run, &changed_files, &verification_summary);
    CodeProReportFacts {
        outcome,
        task_kind: input.task_kind.to_string(),
        risk_tier: input.risk_assessment.tier,
        risk_reasons: input.risk_assessment.reasons.clone(),
        review_required,
        completion_allowed,
        locale: "zh-CN".to_string(),
        trusted_project_root,
        changed_files,
        verification_summary,
        reviewer_approved: input.reviewer_approved,
        limitations,
        recovery_action: input.recovery_action,
        classification_counts,
        evidence,
        agent_results,
    }
}

fn agent_results_from_run(
    run: &CodeProRunResult,
    changed_files: &[String],
    verification_summary: &[VerificationSummary],
) -> Vec<UserAgentResultV1> {
    use crate::agents::{agent_role::AgentRole, task_dag::TaskStatus};

    let mut results = Vec::new();
    for role in [
        AgentRole::Planner,
        AgentRole::Coder,
        AgentRole::Tester,
        AgentRole::Reviewer,
    ] {
        let tasks = run
            .tasks
            .iter()
            .filter(|task| task.role == role)
            .collect::<Vec<_>>();
        if tasks.is_empty() {
            continue;
        }
        let file_list = natural_file_list(changed_files);
        let work = match role {
            AgentRole::Planner => "分析了你的需求，确定了实现和检查步骤。".to_string(),
            AgentRole::Coder => {
                if file_list.is_empty() {
                    "未记录到项目文件改动。".to_string()
                } else {
                    format!("创建或更新了 {file_list}。")
                }
            }
            AgentRole::Tester => tester_work_from_evidence(run, &tasks),
            AgentRole::Reviewer => "复核了修改内容和检查结果。".to_string(),
        };
        let result = if tasks.iter().all(|task| task.status == TaskStatus::Done) {
            match role {
                AgentRole::Tester => {
                    let task_ids = tasks
                        .iter()
                        .map(|task| task.id.as_str())
                        .collect::<std::collections::HashSet<_>>();
                    let tester_verification = verification_summary
                        .iter()
                        .filter(|item| task_ids.contains(item.task_id.as_str()))
                        .collect::<Vec<_>>();
                    let final_verification = tester_verification
                        .iter()
                        .filter(|item| !run.diagnostic_tasks.contains(&item.task_id))
                        .collect::<Vec<_>>();
                    let diagnostic_failed = tester_verification.iter().any(|item| {
                        run.diagnostic_tasks.contains(&item.task_id)
                            && item.verdict == VerificationVerdict::Failed
                    });
                    if !final_verification.is_empty()
                        && tasks
                            .iter()
                            .filter(|task| !run.diagnostic_tasks.contains(&task.id))
                            .all(|task| tester_has_execution_evidence(run, &task.id))
                        && final_verification
                            .iter()
                            .all(|item| item.verdict == VerificationVerdict::Passed)
                    {
                        if diagnostic_failed {
                            "初始诊断记录了失败；后续回归验证通过，详见各次命令回执。".to_string()
                        } else {
                            "最终验证通过，仅代表已执行的检查范围。".to_string()
                        }
                    } else if tester_verification
                        .iter()
                        .any(|item| item.verdict == VerificationVerdict::Failed)
                    {
                        "检查没有通过，结果已经保留。".to_string()
                    } else {
                        "没有取得可确认的测试结果。".to_string()
                    }
                }
                AgentRole::Planner => "执行方案已准备完成。".to_string(),
                AgentRole::Coder if file_list.is_empty() => {
                    "执行步骤已结束；没有文件改动，目标是否满足以验证结果为准。".to_string()
                }
                AgentRole::Coder => "修改已经保存到项目中。".to_string(),
                AgentRole::Reviewer => "复核已经完成。".to_string(),
            }
        } else if tasks.iter().all(|task| task.status == TaskStatus::Skipped) {
            "已跳过动态验证；该项未运行，不能据此判断是否存在 Bug。".to_string()
        } else if tasks
            .iter()
            .any(|task| task.status == TaskStatus::WaitingForUser)
        {
            "当前步骤正在等待必要信息，尚未完成。".to_string()
        } else if tasks.iter().any(|task| task.status == TaskStatus::Paused) {
            "当前步骤已暂停，尚未完成；恢复条件见后续说明。".to_string()
        } else {
            "这部分尚未完成，具体原因已收录在技术详情中。".to_string()
        };
        results.push(UserAgentResultV1 {
            agent: role.display_name_zh().to_string(),
            work,
            result,
        });
    }
    results
}

fn tester_has_execution_evidence(run: &CodeProRunResult, task_id: &str) -> bool {
    if run.tasks.iter().any(|task| {
        task.id == task_id
            && task
                .current_output
                .as_ref()
                .is_some_and(|output| output.validation_not_run.is_some())
    }) {
        return false;
    }
    run.verification_groups.iter().any(|group| {
        if group.task_id != task_id {
            return false;
        }
        if let Ok(evidence) =
            serde_json::from_str::<VerificationEvidenceV1>(&group.current.evidence)
        {
            return matches!(
                evidence.execution_outcome,
                crate::agents::task_dag::ExecutionOutcome::Succeeded
                    | crate::agents::task_dag::ExecutionOutcome::VerificationFailed
            ) && (evidence.exit_code.is_some() || evidence.artifact_sha256.is_some());
        }
        group.current.exit_code.is_some()
    })
}

fn tester_work_from_evidence(
    run: &CodeProRunResult,
    tasks: &[&crate::agents::codepro_run_result::AggregatedTaskResult],
) -> String {
    use crate::agents::task_dag::TaskStatus;

    let executed = tasks
        .iter()
        .copied()
        .filter(|task| tester_has_execution_evidence(run, &task.id))
        .collect::<Vec<_>>();
    if executed.is_empty() {
        if tasks.iter().all(|task| task.status == TaskStatus::Skipped) {
            return tester_not_run_work(tasks);
        }
        return "尚未取得测试执行证据；准备步骤或查看文件不代表已运行测试。".to_string();
    }
    let names = natural_task_list(&executed);
    let mut work = if names.is_empty() {
        "已执行有记录的验证，具体命令和结果见技术详情。".to_string()
    } else {
        format!("已取得“{names}”的实际验证执行记录。")
    };
    if executed.len() != tasks.len()
        || tasks
            .iter()
            .any(|task| matches!(task.status, TaskStatus::WaitingForUser | TaskStatus::Paused))
    {
        work.push_str("仅上述记录证明已执行；仍在等待或已跳过的步骤不计为完成。");
    }
    work
}

fn tester_not_run_work(
    tasks: &[&crate::agents::codepro_run_result::AggregatedTaskResult],
) -> String {
    use crate::agents::task_dag::ValidationNotRunReasonV1;

    let mut user_requested = 0;
    let mut host_boundary = 0;
    let mut unknown = 0;
    for task in tasks {
        match task
            .current_output
            .as_ref()
            .and_then(|output| output.validation_not_run.as_ref())
            .map(|evidence| evidence.reason)
        {
            Some(ValidationNotRunReasonV1::UserRequested) => user_requested += 1,
            Some(ValidationNotRunReasonV1::HostBoundary) => host_boundary += 1,
            Some(ValidationNotRunReasonV1::Unknown) | None => unknown += 1,
        }
    }

    let mut reasons = Vec::new();
    if user_requested > 0 {
        reasons.push(format!("{user_requested} 项由用户明确选择跳过"));
    }
    if host_boundary > 0 {
        reasons.push(format!("{host_boundary} 项被宿主有界验证边界跳过"));
    }
    if unknown > 0 {
        reasons.push(format!("{unknown} 项原因未确认"));
    }
    format!(
        "动态验证未执行：{}；未执行测试命令，未取得测试执行证据。",
        reasons.join("，")
    )
}

fn natural_file_list(files: &[String]) -> String {
    let mut visible = files.iter().take(3).cloned().collect::<Vec<_>>();
    if files.len() > 3 {
        visible.push(format!("另外 {} 个文件", files.len() - 3));
    }
    visible.join("、")
}

fn natural_task_list(tasks: &[&crate::agents::codepro_run_result::AggregatedTaskResult]) -> String {
    tasks
        .iter()
        .map(|task| task.name.trim())
        .filter(|name| {
            !name.is_empty()
                && !name.eq_ignore_ascii_case("task")
                && !name.to_ascii_lowercase().contains("internal task")
                && !name.to_ascii_lowercase().starts_with("task-")
        })
        .take(3)
        .map(sanitize_report_inline)
        .collect::<Vec<_>>()
        .join("、")
}

fn outcome_from_run_status(status: CodeProRunStatus) -> CodeProTerminalOutcome {
    match status {
        CodeProRunStatus::Completed => CodeProTerminalOutcome::Completed,
        CodeProRunStatus::Paused => CodeProTerminalOutcome::Paused,
        CodeProRunStatus::Discarded => CodeProTerminalOutcome::Cancelled,
        CodeProRunStatus::Failed => CodeProTerminalOutcome::Failed,
        CodeProRunStatus::Planning | CodeProRunStatus::Running | CodeProRunStatus::Reviewing => {
            CodeProTerminalOutcome::Partial
        }
    }
}

fn trusted_relative_path(root: Option<&Path>, candidate: &str) -> Option<String> {
    let root = root?;
    let path = Path::new(candidate);
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?.to_path_buf()
    } else {
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return None;
        }
        path.to_path_buf()
    };
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        None
    } else {
        Some(relative.to_string_lossy().replace('\\', "/"))
    }
}

fn normalize_canonical_report_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let display = path.to_string_lossy();
        if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive_path) = display.strip_prefix(r"\\?\") {
            return PathBuf::from(drive_path);
        }
    }
    path
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum ReportValidationError {
    #[error("report draft schema_version must be 1")]
    InvalidSchemaVersion,
    #[error("report field is empty")]
    EmptyText,
    #[error("report exceeds the visible size limit")]
    TooLarge,
    #[error("report item has no evidence reference")]
    MissingEvidenceReference,
    #[error("unknown report evidence: {0}")]
    UnknownEvidence(String),
    #[error("evidence {evidence_id} is incompatible with section {section}")]
    IncompatibleEvidence {
        section: &'static str,
        evidence_id: String,
    },
    #[error("host limitation is missing from draft: {0}")]
    MissingLimitation(String),
    #[error("draft contains a forbidden claim: {0}")]
    ForbiddenClaim(&'static str),
}

pub(crate) fn fallback_draft(facts: &CodeProReportFacts) -> ReportDraftV1 {
    let summary = match facts.outcome {
        CodeProTerminalOutcome::Completed if facts.completion_allowed => {
            "本次任务已完成，改动和验证结果均已记录。".to_string()
        }
        CodeProTerminalOutcome::Completed => {
            "执行工作已经结束，但现有证据不足以确认任务完整完成。".to_string()
        }
        CodeProTerminalOutcome::Skipped => {
            "没有运行动态测试；下面只列出已经确认的信息，不能据此判断整个任务已经完成。".to_string()
        }
        CodeProTerminalOutcome::Partial => {
            "本次任务只完成了一部分，仍有工作或验证尚未收敛。".to_string()
        }
        CodeProTerminalOutcome::Paused => {
            "任务已暂停，下面列出已记录的改动、验证和阻止原因；是否可恢复以检查点记录为准。"
                .to_string()
        }
        CodeProTerminalOutcome::WaitingForUser => {
            "任务正在等待你的确认；现有步骤状态和验证证据已安全保留。".to_string()
        }
        CodeProTerminalOutcome::Cancelled => {
            "任务已取消；取消前产生的改动和验证结果仍列在下方。".to_string()
        }
        CodeProTerminalOutcome::PlanningFailed if facts.changed_files.is_empty() => {
            "本次未开始修改项目，因为规划阶段未能生成可安全执行的计划。".to_string()
        }
        CodeProTerminalOutcome::PlanningFailed => {
            "规划阶段未能生成可安全执行的计划，并且检测到尚未完整验证的项目改动。".to_string()
        }
        CodeProTerminalOutcome::SchedulingFailed => {
            "任务调度未能继续；已经产生的改动不代表整项任务已经完成。".to_string()
        }
        CodeProTerminalOutcome::ReviewFailed => {
            "改动或验证可能已经产生，但独立审查尚未完成，因此不能确认最终完成。".to_string()
        }
        CodeProTerminalOutcome::Failed if facts.limitations.is_empty() => {
            "本次任务未能完成；最终验证结论和已确认改动均已保留。".to_string()
        }
        CodeProTerminalOutcome::Failed => {
            "本次任务未能完成；已确认的改动和验证结果均已保留。".to_string()
        }
    };

    let changes = facts
        .changed_files
        .iter()
        .filter_map(|file| {
            evidence_id_for(facts, ReportEvidenceKind::File, file).map(|evidence_id| {
                ReportDraftItem {
                    text: format!("修改了 {file}。"),
                    evidence_refs: vec![evidence_id],
                }
            })
        })
        .take(5)
        .collect();
    let verification = facts
        .verification_summary
        .iter()
        .take(5)
        .map(|item| {
            let text = match item.verdict {
                VerificationVerdict::Passed
                    if facts.outcome == CodeProTerminalOutcome::Completed =>
                {
                    "相关验证已通过。".to_string()
                }
                VerificationVerdict::Passed => "已有验证通过，但整体任务尚未完成。".to_string(),
                VerificationVerdict::Skipped => "动态测试没有运行。".to_string(),
                VerificationVerdict::Failed => "相关验证未通过。".to_string(),
                VerificationVerdict::Unavailable => {
                    "所需环境或测试暂不可用，因此尚未完成验证。".to_string()
                }
                VerificationVerdict::Unverified => "当前还没有可信的验证结论。".to_string(),
            };
            ReportDraftItem {
                text,
                evidence_refs: vec![item.evidence_ref.clone()],
            }
        })
        .collect();
    let mut limitations = facts
        .limitations
        .iter()
        .take(4)
        .enumerate()
        .map(|(index, limitation)| ReportDraftItem {
            text: limitation_text(limitation),
            evidence_refs: vec![format!("limitation-{}", index + 1)],
        })
        .collect::<Vec<_>>();
    if facts.limitations.len() > 4 {
        limitations.push(ReportDraftItem {
            text: format!(
                "另有 {} 项尚未完成，完整内容见技术详情。",
                facts.limitations.len() - 4
            ),
            evidence_refs: (5..=facts.limitations.len())
                .map(|index| format!("limitation-{index}"))
                .collect(),
        });
    }
    let next_step =
        (facts.recovery_action != ReportRecoveryAction::None).then(|| ReportDraftItem {
            text: recovery_text(facts.recovery_action),
            evidence_refs: vec!["run-state".to_string()],
        });

    ReportDraftV1 {
        schema_version: 1,
        summary,
        changes,
        verification,
        limitations,
        next_step,
    }
}

pub(crate) fn validate_draft(
    facts: &CodeProReportFacts,
    draft: &ReportDraftV1,
) -> Result<(), ReportValidationError> {
    if draft.schema_version != 1 {
        return Err(ReportValidationError::InvalidSchemaVersion);
    }
    if draft.summary.trim().is_empty() {
        return Err(ReportValidationError::EmptyText);
    }
    if sentence_count(&draft.summary) > 1
        || draft.changes.len() > 5
        || draft.verification.len() > 5
        || draft.limitations.len() > 5
        || visible_character_count(draft) > 1_500
    {
        return Err(ReportValidationError::TooLarge);
    }

    validate_items(
        facts,
        "changes",
        &draft.changes,
        &[ReportEvidenceKind::File],
    )?;
    validate_items(
        facts,
        "verification",
        &draft.verification,
        &[ReportEvidenceKind::Verification],
    )?;
    validate_items(
        facts,
        "limitations",
        &draft.limitations,
        &[ReportEvidenceKind::Limitation],
    )?;
    if let Some(item) = &draft.next_step {
        validate_items(
            facts,
            "next_step",
            std::slice::from_ref(item),
            &[ReportEvidenceKind::RunState, ReportEvidenceKind::Limitation],
        )?;
    }

    for evidence in facts
        .evidence
        .values()
        .filter(|item| item.kind == ReportEvidenceKind::Limitation)
    {
        if !draft
            .limitations
            .iter()
            .any(|item| item.evidence_refs.iter().any(|id| id == &evidence.id))
        {
            return Err(ReportValidationError::MissingLimitation(
                evidence.value.clone(),
            ));
        }
    }

    let all_text = draft_text(draft).to_lowercase();
    if [
        "not_run",
        "waiting_for_user",
        "waiting_for_env_or_permission",
        "recovery_action",
    ]
    .iter()
    .any(|code| all_text.contains(code))
    {
        return Err(ReportValidationError::ForbiddenClaim(
            "internal_status_code",
        ));
    }
    if !facts.completion_allowed && has_completion_claim(&all_text) {
        return Err(ReportValidationError::ForbiddenClaim("completion"));
    }
    let all_verification_passed = !facts.verification_summary.is_empty()
        && facts
            .verification_summary
            .iter()
            .all(|item| item.verdict == VerificationVerdict::Passed);
    if !all_verification_passed && has_passing_claim(&draft.summary.to_lowercase()) {
        return Err(ReportValidationError::ForbiddenClaim("verification_pass"));
    }
    for item in &draft.verification {
        if has_passing_claim(&item.text.to_lowercase())
            && item.evidence_refs.iter().any(|id| {
                facts.verification_summary.iter().any(|summary| {
                    &summary.evidence_ref == id && summary.verdict != VerificationVerdict::Passed
                })
            })
        {
            return Err(ReportValidationError::ForbiddenClaim("verification_pass"));
        }
    }
    if !facts.reviewer_approved && has_approval_claim(&all_text) {
        return Err(ReportValidationError::ForbiddenClaim("review_approval"));
    }

    Ok(())
}

pub(crate) fn validate_rewrite_draft(
    facts: &CodeProReportFacts,
    draft: &ReportDraftV1,
) -> Result<(), ReportValidationError> {
    validate_draft(facts, draft)?;
    let text = draft_text(draft).to_lowercase();
    if text.chars().any(|character| character.is_ascii_digit()) {
        return Err(ReportValidationError::ForbiddenClaim(
            "untrusted_numeric_detail",
        ));
    }
    if text.contains(['/', '\\', '`'])
        || [
            ".rs", ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".cs", ".cpp", ".toml",
            ".json", ".yaml", ".yml", "cargo ", "pnpm ", "npm ", "pytest", "go test", "dotnet ",
            "gradle ", "mvn ",
        ]
        .iter()
        .any(|marker| text.contains(marker))
    {
        return Err(ReportValidationError::ForbiddenClaim(
            "untrusted_path_or_command_detail",
        ));
    }
    Ok(())
}

pub(crate) fn render_report(facts: &CodeProReportFacts, draft: &ReportDraftV1) -> String {
    let terminal_state = match facts.outcome {
        CodeProTerminalOutcome::Completed => "PASS",
        CodeProTerminalOutcome::Skipped => "NOT_RUN",
        CodeProTerminalOutcome::Failed => "FAIL",
        CodeProTerminalOutcome::WaitingForUser => "WAITING_FOR_USER",
        CodeProTerminalOutcome::Partial
        | CodeProTerminalOutcome::Paused
        | CodeProTerminalOutcome::Cancelled
        | CodeProTerminalOutcome::PlanningFailed
        | CodeProTerminalOutcome::SchedulingFailed
        | CodeProTerminalOutcome::ReviewFailed => "BLOCKED",
    };
    let mut technical_details = vec![format!("终态：{terminal_state}")];
    if let Some(root) = &facts.trusted_project_root {
        technical_details.push(format!(
            "项目：`{}`",
            escape_inline_code(&root.to_string_lossy())
        ));
    }
    for file in facts.changed_files.iter().take(10) {
        technical_details.push(format!("文件：`{}`", escape_inline_code(file)));
    }
    for verification in facts.verification_summary.iter().take(10) {
        let command = verification
            .command
            .as_deref()
            .map(escape_inline_code)
            .unwrap_or_else(|| match verification.verdict {
                VerificationVerdict::Unavailable => "未执行（测试入口或环境不可用）".to_string(),
                _ => "未记录命令".to_string(),
            });
        let exit_code = verification
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| match verification.verdict {
                VerificationVerdict::Skipped => "NOT_RUN".to_string(),
                _ => "未记录".to_string(),
            });
        technical_details.push(format!(
            "验证 {}：{:?}（`{}`；退出码：{}）",
            escape_narrative(&verification.task_id),
            verification.verdict,
            command,
            escape_narrative(&exit_code)
        ));
    }
    for limitation in facts.limitations.iter().take(20) {
        technical_details.push(format!(
            "待处理：{}",
            escape_narrative(&limitation_text(limitation))
        ));
    }
    let risk_tier = match facts.risk_tier {
        CodeProRiskTier::L0ReadOnly => "L0 只读",
        CodeProRiskTier::L1ReversibleChange => "L1 可逆修改",
        CodeProRiskTier::L2Feature => "L2 普通功能",
        CodeProRiskTier::L3HighRiskRelease => "L3 高风险/发布",
    };
    technical_details.push(format!("执行级别：{risk_tier}"));
    technical_details.push(format!(
        "Reviewer：{}",
        if !facts.review_required {
            "本级别不要求"
        } else if facts.reviewer_approved {
            "已批准"
        } else {
            "未确认批准"
        }
    ));
    let changes = draft
        .changes
        .iter()
        .map(|item| render_user_report_item(facts, item, "changes"))
        .collect();
    let fallback_verification;
    let verification_items =
        if draft.verification.is_empty() && !facts.verification_summary.is_empty() {
            fallback_verification = fallback_draft(facts).verification;
            &fallback_verification
        } else {
            &draft.verification
        };
    let verification = verification_items
        .iter()
        .map(|item| render_user_report_item(facts, item, "verification"))
        .collect();
    let mut user_actions = draft
        .limitations
        .iter()
        .map(|item| render_user_report_item(facts, item, "limitations"))
        .collect::<Vec<_>>();
    if let Some(next_step) = &draft.next_step {
        user_actions.push(render_user_report_item(facts, next_step, "next_step"));
    }

    let mut visible_summary = escape_narrative(&draft.summary);
    if let Some(root) = &facts.trusted_project_root {
        if !visible_summary.ends_with(['。', '！', '？', '.', '!', '?']) {
            visible_summary.push('。');
        }
        visible_summary.push_str(" 项目位置：");
        visible_summary.push_str(&escape_narrative(&root.to_string_lossy()));
        visible_summary.push('。');
    }

    render_user_report_v1(&UserReportV1 {
        schema_version: 1,
        result: visible_summary,
        agent_results: facts.agent_results.clone(),
        changes,
        verification,
        user_actions,
        technical_details,
    })
}

fn render_user_report_item(
    facts: &CodeProReportFacts,
    item: &ReportDraftItem,
    section: &str,
) -> String {
    let mut rendered = escape_narrative(&item.text);
    render_host_fact_suffix(&mut rendered, facts, item, section);
    rendered
}

pub(crate) fn terminal_payload(facts: &CodeProReportFacts) -> CodeProTerminalReportPayload {
    CodeProTerminalReportPayload {
        outcome: facts.outcome,
        classification_counts: facts.classification_counts.clone(),
        changed_files: facts.changed_files.clone(),
        verification_summary: facts.verification_summary.clone(),
        limitations: facts.limitations.clone(),
        recovery_action: facts.recovery_action,
        risk_tier: Some(facts.risk_tier),
        risk_reasons: facts.risk_reasons.clone(),
        review_required: facts.review_required,
    }
}

fn evidence_id_for(
    facts: &CodeProReportFacts,
    kind: ReportEvidenceKind,
    value: &str,
) -> Option<String> {
    facts
        .evidence
        .values()
        .find(|item| item.kind == kind && item.value == value)
        .map(|item| item.id.clone())
}

fn validate_items(
    facts: &CodeProReportFacts,
    section: &'static str,
    items: &[ReportDraftItem],
    compatible_kinds: &[ReportEvidenceKind],
) -> Result<(), ReportValidationError> {
    for item in items {
        if item.text.trim().is_empty() {
            return Err(ReportValidationError::EmptyText);
        }
        if item.evidence_refs.is_empty() {
            return Err(ReportValidationError::MissingEvidenceReference);
        }
        let mut unique_refs = std::collections::BTreeSet::new();
        for evidence_id in &item.evidence_refs {
            if !unique_refs.insert(evidence_id) {
                continue;
            }
            let evidence = facts
                .evidence
                .get(evidence_id)
                .ok_or_else(|| ReportValidationError::UnknownEvidence(evidence_id.clone()))?;
            if !compatible_kinds.contains(&evidence.kind) {
                return Err(ReportValidationError::IncompatibleEvidence {
                    section,
                    evidence_id: evidence_id.clone(),
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn limitation_text(code: &str) -> String {
    if let Some(payload) = code.strip_prefix("goal_requirement_unverified:") {
        let mut fields = payload.splitn(2, ':');
        let requirement_id = fields.next().unwrap_or("unknown");
        let description = fields.next().unwrap_or("未记录具体描述");
        return format!("验收要求 {requirement_id} 尚未取得可信证据：{description}。");
    }
    if let Some(task_id) = code.strip_prefix("typed_verification_not_passed:") {
        return format!("验证任务 {task_id} 尚未取得通过的宿主命令回执。");
    }
    match code {
        "planning_unavailable" => "规划阶段未能生成可安全执行的计划。".to_string(),
        "planning_requires_clarification" => {
            "规划仍缺少可安全决定实现方向的信息，请补充目标或范围。".to_string()
        }
        "planning_failed_closed" => {
            "高风险任务的规划纠错仍失败，CodePro 已停止且没有降级执行。".to_string()
        }
        "review_unavailable" => "独立审查尚未完成。".to_string(),
        "file_evidence_unavailable" => "无法建立可信的文件变更基线。".to_string(),
        "project_scope_too_broad" => "当前工作目录范围过大，证据采集未能在时限内完成。".to_string(),
        "out_of_workspace_operation" => "检测到工作区外操作，未将其计入可信项目改动。".to_string(),
        "recovery_paused" => "恢复上次任务时暂停；当前报告没有证明已提交可恢复检查点。".to_string(),
        "checkpoint_paused" => "任务已暂停，进度已保存为检查点，可继续未完成步骤。".to_string(),
        "legacy_unclassified" => "历史任务的暂停原因未记录，进度已保留。".to_string(),
        "task_failure" => "执行任务未完成，已保留可以确认的结果。".to_string(),
        "verification_recovery_failed" => "自动复测尚未通过，验证证据已保留。".to_string(),
        "repair_branch_unavailable" => {
            "自动修复执行器未完成有界重试，现有改动和证据已保留。".to_string()
        }
        _ => "有一项未完成原因暂时无法用通俗语言说明；运行记录已经保留，请重试或查看运行记录。"
            .to_string(),
    }
}

fn recovery_text(action: ReportRecoveryAction) -> String {
    match action {
        ReportRecoveryAction::None => String::new(),
        ReportRecoveryAction::RetryPlanning => "请重试规划；必要时简化请求。".to_string(),
        ReportRecoveryAction::ContinueCheckpoint => "可从当前检查点继续任务。".to_string(),
        ReportRecoveryAction::AskUser => {
            "请在聊天中确认当前步骤所需的命令、路径或权限；收到你的答复后再继续。".to_string()
        }
        ReportRecoveryAction::RetryValidation => "请重新运行未完成的验证。".to_string(),
        ReportRecoveryAction::RetryReview => "请重新执行独立审查。".to_string(),
        ReportRecoveryAction::SelectProjectDirectory => {
            "请选择明确且安全的项目目录后重试。".to_string()
        }
        ReportRecoveryAction::ManualReview => "请人工检查现有改动和验证结果。".to_string(),
    }
}

fn render_host_fact_suffix(
    report: &mut String,
    facts: &CodeProReportFacts,
    item: &ReportDraftItem,
    section: &str,
) {
    match section {
        "changes" => {
            let files = item
                .evidence_refs
                .iter()
                .filter_map(|id| facts.evidence.get(id))
                .filter(|evidence| evidence.kind == ReportEvidenceKind::File)
                .map(|evidence| evidence.value.as_str())
                .filter(|file| !item.text.contains(file))
                .collect::<Vec<_>>();
            if !files.is_empty() {
                report.push('（');
                report.push_str(
                    &files
                        .iter()
                        .map(|file| format!("`{}`", escape_inline_code(file)))
                        .collect::<Vec<_>>()
                        .join("、"),
                );
                report.push('）');
            }
        }
        "verification" => {
            let details = item
                .evidence_refs
                .iter()
                .filter_map(|id| {
                    facts
                        .verification_summary
                        .iter()
                        .find(|summary| &summary.evidence_ref == id)
                })
                .map(|summary| {
                    match summary.verdict {
                        VerificationVerdict::Passed => "通过",
                        VerificationVerdict::Skipped => "未运行动态测试",
                        VerificationVerdict::Failed => "失败",
                        VerificationVerdict::Unverified => "未验证",
                        VerificationVerdict::Unavailable => "不可用",
                    }
                    .to_string()
                })
                .collect::<Vec<_>>();
            if !details.is_empty() {
                report.push('（');
                report.push_str(&details.join("；"));
                report.push('）');
            }
        }
        "limitations" => {
            let missing = item
                .evidence_refs
                .iter()
                .filter_map(|id| facts.evidence.get(id))
                .filter(|evidence| evidence.kind == ReportEvidenceKind::Limitation)
                .map(|evidence| limitation_text(&evidence.value))
                .filter(|limitation| !item.text.contains(limitation.trim_end_matches('。')))
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                report.push('（');
                report.push_str(&escape_narrative(&missing.join("；")));
                report.push('）');
            }
        }
        _ => {}
    }
}

fn escape_narrative(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('`', "ˋ")
}

fn escape_inline_code(text: &str) -> String {
    text.replace('`', "ˋ").replace(['\r', '\n'], " ")
}

fn sentence_count(text: &str) -> usize {
    let count = text
        .chars()
        .filter(|character| matches!(character, '。' | '！' | '？' | '.' | '!' | '?'))
        .count();
    count.max(1)
}

fn visible_character_count(draft: &ReportDraftV1) -> usize {
    draft_text(draft).chars().count()
}

fn draft_text(draft: &ReportDraftV1) -> String {
    std::iter::once(draft.summary.as_str())
        .chain(draft.changes.iter().map(|item| item.text.as_str()))
        .chain(draft.verification.iter().map(|item| item.text.as_str()))
        .chain(draft.limitations.iter().map(|item| item.text.as_str()))
        .chain(draft.next_step.iter().map(|item| item.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_completion_claim(text: &str) -> bool {
    [
        "已完成",
        "全部完成",
        "successfully completed",
        "task completed",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn has_passing_claim(text: &str) -> bool {
    [
        "全部通过",
        "测试通过",
        "验证通过",
        "all tests passed",
        "checks passed",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn has_approval_claim(text: &str) -> bool {
    ["reviewer 已批准", "审查通过", "reviewer approved"]
        .iter()
        .any(|marker| text.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_diagnostics_are_collapsed_redacted_and_bounded() {
        let evidence = crate::agents::tool_task::ToolTaskProgress::default().action_evidence();
        let error = goose_providers::errors::ProviderError::EndpointNotFound(
            "missing-route api_key=fixture-secret </details> ```".into(),
        );
        for chinese in [true, false] {
            let report = render_main_agent_provider_error(&error, &evidence, chinese);
            let (summary, details) = report.split_once("<details>").unwrap();
            assert!(!summary.contains("missing-route"));
            assert!(details.contains("Endpoint not found (404)"));
            assert!(details.contains("missing-route"));
            assert!(details.contains("[REDACTED]"));
            assert!(!report.contains("fixture-secret"));
            assert_eq!(report.matches("</details>").count(), 1);
            assert!(details.contains("````text"));
        }
        let report = render_main_agent_provider_error(
            &goose_providers::errors::ProviderError::ServerError("错".repeat(5000)),
            &evidence,
            true,
        );
        assert!(report.contains("[TRUNCATED]"));
        assert!(report.chars().count() < 5000);
    }

    use crate::agents::agent_role::{CodeProRiskAssessment, CodeProRiskReason, CodeProRiskTier};
    use crate::agents::codepro_run_result::{
        CodeProRunResult, VerificationAttempt, VerificationGroup, VerificationOutcome,
    };
    use crate::agents::codepro_state_store::CodeProRunStatus;
    use crate::agents::control_plane::{ConvergenceAssessment, ConvergenceStatus};
    use serde_json::json;
    use std::fs;

    fn verification_group(
        task_id: &str,
        key: &str,
        outcome: VerificationOutcome,
    ) -> VerificationGroup {
        VerificationGroup {
            task_id: task_id.to_string(),
            key: key.to_string(),
            current: VerificationAttempt {
                outcome,
                evidence: format!("{key} evidence"),
                exit_code: None,
            },
            history: Vec::new(),
        }
    }

    fn empty_run() -> CodeProRunResult {
        CodeProRunResult {
            diagnostic_tasks: Default::default(),
            tasks: Vec::new(),
            verification_groups: Vec::new(),
            current_files: Vec::new(),
            review_summaries: Vec::new(),
        }
    }

    fn done_task(
        id: &str,
        role: crate::agents::agent_role::AgentRole,
    ) -> crate::agents::codepro_run_result::AggregatedTaskResult {
        crate::agents::codepro_run_result::AggregatedTaskResult {
            id: id.to_string(),
            name: format!("{id} internal task"),
            role,
            status: crate::agents::task_dag::TaskStatus::Done,
            current_output: Some(crate::agents::task_dag::TaskOutput {
                change_report: "确认 Bug：无\n未验证：无\nNOT_RUN".to_string(),
                ..Default::default()
            }),
            has_current_evidence: true,
            has_current_verification: role == crate::agents::agent_role::AgentRole::Tester,
        }
    }

    fn risk_assessment(tier: CodeProRiskTier) -> CodeProRiskAssessment {
        let reason = match tier {
            CodeProRiskTier::L0ReadOnly => CodeProRiskReason::ReadOnly,
            CodeProRiskTier::L1ReversibleChange => CodeProRiskReason::SingleWorkspaceFile,
            CodeProRiskTier::L2Feature => CodeProRiskReason::MultiFileOrUnknownWriteScope,
            CodeProRiskTier::L3HighRiskRelease => CodeProRiskReason::PermissionBoundary,
        };
        CodeProRiskAssessment {
            tier,
            reasons: vec![reason],
        }
    }

    fn tier_completion_facts(
        tier: CodeProRiskTier,
        verification: VerificationOutcome,
        reviewer_approved: bool,
        convergence: Option<&ConvergenceAssessment>,
    ) -> CodeProReportFacts {
        let mut run = empty_run();
        run.verification_groups = vec![verification_group("test-task", "cargo test", verification)];
        let risk = risk_assessment(tier);
        build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::Completed),
            run_status: CodeProRunStatus::Completed,
            convergence,
            run: &run,
            trusted_project_root: None,
            task_kind: "feature",
            risk_assessment: &risk,
            reviewer_approved,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::None,
        })
    }

    #[test]
    fn tier_completion_requires_only_the_host_gates_for_that_tier() {
        let eligible = ConvergenceAssessment {
            status: ConvergenceStatus::Eligible,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };
        let blocked = ConvergenceAssessment {
            status: ConvergenceStatus::Blocked,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };

        let l1 = tier_completion_facts(
            CodeProRiskTier::L1ReversibleChange,
            VerificationOutcome::Passed,
            false,
            Some(&eligible),
        );
        assert!(l1.completion_allowed);
        assert!(!l1.review_required);

        let l2 = tier_completion_facts(
            CodeProRiskTier::L2Feature,
            VerificationOutcome::Passed,
            false,
            Some(&eligible),
        );
        assert!(l2.completion_allowed);
        assert!(!l2.review_required);

        let l3_without_review = tier_completion_facts(
            CodeProRiskTier::L3HighRiskRelease,
            VerificationOutcome::Passed,
            false,
            Some(&eligible),
        );
        assert!(!l3_without_review.completion_allowed);
        assert!(l3_without_review.review_required);

        let l3_approved = tier_completion_facts(
            CodeProRiskTier::L3HighRiskRelease,
            VerificationOutcome::Passed,
            true,
            Some(&eligible),
        );
        assert!(l3_approved.completion_allowed);

        let failed_test = tier_completion_facts(
            CodeProRiskTier::L3HighRiskRelease,
            VerificationOutcome::TestFailed,
            true,
            Some(&eligible),
        );
        assert!(!failed_test.completion_allowed);

        let blocked_convergence = tier_completion_facts(
            CodeProRiskTier::L3HighRiskRelease,
            VerificationOutcome::Passed,
            true,
            Some(&blocked),
        );
        assert!(!blocked_convergence.completion_allowed);
        assert_ne!(
            blocked_convergence.outcome,
            CodeProTerminalOutcome::Completed
        );
    }

    #[test]
    fn successful_lower_tier_report_hides_internal_review_metadata() {
        let eligible = ConvergenceAssessment {
            status: ConvergenceStatus::Eligible,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };
        let facts = tier_completion_facts(
            CodeProRiskTier::L2Feature,
            VerificationOutcome::Passed,
            false,
            Some(&eligible),
        );
        let report = render_report(&facts, &fallback_draft(&facts));

        let (visible, technical) = report.split_once("<details>").unwrap();
        assert!(!visible.contains("执行级别：L2 普通功能"));
        assert!(!visible.contains("Reviewer：本级别不要求"));
        assert!(technical.contains("执行级别：L2 普通功能"));
        assert!(!report.contains("【详见技术证据】"));
    }

    #[test]
    fn report_renders_one_authoritative_terminal_state() {
        let eligible = ConvergenceAssessment {
            status: ConvergenceStatus::Eligible,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };
        let completed = tier_completion_facts(
            CodeProRiskTier::L2Feature,
            VerificationOutcome::Passed,
            false,
            Some(&eligible),
        );
        let blocked = facts_with_evidence(CodeProTerminalOutcome::ReviewFailed, false);
        let failed = facts_with_evidence(CodeProTerminalOutcome::Failed, false);

        let completed_report = render_report(&completed, &fallback_draft(&completed));
        assert!(completed_report.contains("本次任务已完成"));
        let (visible, technical) = completed_report.split_once("<details>").unwrap();
        assert!(!visible.contains("终态：PASS"));
        assert_eq!(technical.matches("终态：PASS").count(), 1);
        assert!(render_report(&blocked, &fallback_draft(&blocked)).contains("终态：BLOCKED"));
        assert!(render_report(&failed, &fallback_draft(&failed)).contains("终态：FAIL"));
    }

    #[test]
    fn waiting_for_user_report_asks_for_confirmation_without_claiming_blockage() {
        let mut waiting = facts_with_evidence(CodeProTerminalOutcome::WaitingForUser, false);
        waiting.limitations.clear();
        waiting
            .evidence
            .retain(|_, item| item.kind != ReportEvidenceKind::Limitation);
        waiting.recovery_action = ReportRecoveryAction::AskUser;

        let report = render_report(&waiting, &fallback_draft(&waiting));

        let validation = validate_draft(&waiting, &fallback_draft(&waiting));
        assert!(validation.is_ok(), "{validation:?}");
        assert!(report.contains("等待你的确认"));
        assert!(report.contains("终态：WAITING_FOR_USER"));
        assert!(report.contains("请在聊天中确认当前步骤所需的命令、路径或权限"));
        assert!(!report.contains("BLOCKED"));
        assert!(!report.contains("限制"));
    }

    #[test]
    fn blocked_report_does_not_call_passing_evidence_a_final_validation() {
        let mut blocked = facts_with_evidence(CodeProTerminalOutcome::Paused, false);
        blocked.verification_summary[0].verdict = VerificationVerdict::Passed;

        let report = render_report(&blocked, &fallback_draft(&blocked));

        assert!(report.contains("已有验证通过，但整体任务尚未完成"));
        assert!(!report.contains("最终验证通过"));
        assert!(report.contains("终态：BLOCKED"));
    }

    #[test]
    fn completed_tester_without_host_verification_is_downgraded_to_failed() {
        let tester = crate::agents::task_dag::TaskNode {
            id: "test-task".to_string(),
            name: "测试".to_string(),
            description: "运行测试".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "记录命令、退出码和结果".to_string(),
            status: crate::agents::task_dag::TaskStatus::Done,
            output: None,
            retry_count: 0,
        };
        let run = CodeProRunResult::from_run(
            &crate::agents::task_dag::TaskDAG::new("测试", vec![tester]),
            &[],
        );
        let risk = risk_assessment(CodeProRiskTier::L2Feature);
        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::Completed),
            run_status: CodeProRunStatus::Completed,
            convergence: None,
            run: &run,
            trusted_project_root: None,
            task_kind: "project_test",
            risk_assessment: &risk,
            reviewer_approved: false,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::None,
        });

        assert_eq!(facts.outcome, CodeProTerminalOutcome::Failed);
        assert!(!facts.completion_allowed);
    }

    #[test]
    fn skipped_redundant_tester_does_not_downgrade_a_verified_completed_run() {
        use crate::agents::task_dag::{
            ExecutionOutcome, TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
            VerificationOutcomeV1,
        };

        let verified = TaskNode {
            id: "test-authoritative".to_string(),
            name: "authoritative retest".to_string(),
            description: "run node tests.js".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "exit 0".to_string(),
            status: TaskStatus::Done,
            output: Some(TaskOutput::default()),
            retry_count: 1,
        };
        let redundant = TaskNode {
            id: "test-redundant".to_string(),
            name: "planned duplicate retest".to_string(),
            description: "run node tests.js".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "exit 0".to_string(),
            status: TaskStatus::Skipped,
            output: None,
            retry_count: 0,
        };
        let mut dag = TaskDAG::new("repair", vec![verified, redundant]);
        dag.record_verification(
            "test-authoritative",
            VerificationEvidenceV1 {
                schema_version: 1,
                assertion_id: "assertion-node-tests".to_string(),
                expected: "exit_code:0".to_string(),
                observed_summary: "outcome:Passed;exit_code:0".to_string(),
                exit_code: Some(0),
                outcome: VerificationOutcomeV1::Passed,
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
                tool_ref: "host_verification_v1".to_string(),
                failure_epoch: 1,
                execution_outcome: ExecutionOutcome::Succeeded,
                repair_context: None,
            },
        )
        .unwrap();
        let run = CodeProRunResult::from_run(&dag, &[]);
        let eligible = ConvergenceAssessment {
            status: ConvergenceStatus::Eligible,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };
        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::Completed),
            run_status: CodeProRunStatus::Completed,
            convergence: Some(&eligible),
            run: &run,
            trusted_project_root: None,
            task_kind: "repair",
            risk_assessment: &risk_assessment(CodeProRiskTier::L2Feature),
            reviewer_approved: false,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::None,
        });
        let report = render_report(&facts, &fallback_draft(&facts));

        assert_eq!(facts.outcome, CodeProTerminalOutcome::Completed);
        assert!(facts.completion_allowed);
        assert!(report.contains("本次任务已完成"));
        assert!(!report.contains("整体任务尚未完成"));
    }

    #[test]
    fn user_skipped_dynamic_validation_is_not_reported_as_pass_or_failure() {
        use crate::agents::task_dag::{TaskDAG, TaskNode, TaskOutput, TaskStatus};

        let skipped = TaskNode {
            id: "host-fallback-verify".to_string(),
            name: "独立验证用户目标".to_string(),
            description: "discover and run the project validation command".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "record an authoritative result".to_string(),
            status: TaskStatus::Skipped,
            output: Some(TaskOutput {
                patch: String::new(),
                change_report: "用户已确认跳过动态验证命令".to_string(),
                test_results: Some(
                    "workspace_discovery_not_found\nuser_decision:skip_dynamic_validation\nresult:NOT_RUN"
                        .to_string(),
                ),
                files_changed: Vec::new(),
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let mut dag = TaskDAG::new("静态分析", vec![skipped]);
        dag.record_verification(
            "host-fallback-verify",
            VerificationEvidenceV1 {
                schema_version: 1,
                assertion_id: "not-run-probe".to_string(),
                expected: "exit_code:0".to_string(),
                observed_summary: "command was not run".to_string(),
                exit_code: None,
                outcome: crate::agents::task_dag::VerificationOutcomeV1::Failed,
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
                tool_ref: "bounded_validation_contract".to_string(),
                failure_epoch: 0,
                execution_outcome: crate::agents::task_dag::ExecutionOutcome::WaitingForUser,
                repair_context: None,
            },
        )
        .unwrap();
        let run = CodeProRunResult::from_run(&dag, &[]);
        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::Skipped),
            run_status: CodeProRunStatus::Completed,
            convergence: None,
            run: &run,
            trusted_project_root: None,
            task_kind: "project_test",
            risk_assessment: &risk_assessment(CodeProRiskTier::L2Feature),
            reviewer_approved: false,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::None,
        });
        let report = render_report(&facts, &fallback_draft(&facts));

        assert_eq!(facts.outcome, CodeProTerminalOutcome::Skipped);
        assert!(!report.contains("终态：PASS"), "{report}");
        assert!(!report.contains("终态：FAIL"), "{report}");
        assert!(!report.contains("限制"), "{report}");
        let (visible, technical) = report.split_once("<details>").unwrap();
        assert!(!visible.contains("NOT_RUN"), "{visible}");
        assert!(visible.contains("没有运行动态测试"), "{visible}");
        assert!(technical.contains("终态：NOT_RUN"), "{technical}");
        assert!(technical.contains("退出码：NOT_RUN"), "{technical}");
        assert!(!report.contains("用户已选择"), "{report}");
        assert!(
            validate_draft(&facts, &fallback_draft(&facts)).is_ok(),
            "the host's own NOT_RUN fallback must never trigger its completion-claim guard"
        );
    }

    #[test]
    fn tester_summary_uses_host_owned_not_run_reason_instead_of_model_text() {
        use crate::agents::task_dag::{
            TaskDAG, TaskNode, TaskOutput, TaskStatus, ValidationNotRunEvidenceV1,
            ValidationNotRunReasonV1, VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
        };

        let command = "node -e unsafe";
        let skipped = TaskNode {
            id: "bounded-check".to_string(),
            name: "验证 greeting".to_string(),
            description: "run requested validation".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "record NOT_RUN".to_string(),
            status: TaskStatus::Skipped,
            output: Some(TaskOutput {
                change_report: "模型声称用户要求跳过并且退出码为 0".to_string(),
                test_results: Some(
                    "user_decision:skip_dynamic_validation\n退出码：0\nresult:NOT_RUN".to_string(),
                ),
                validation_not_run: Some(ValidationNotRunEvidenceV1 {
                    schema_version: VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
                    reason: ValidationNotRunReasonV1::HostBoundary,
                    tool_call_id: Some("call-bounded".to_string()),
                    command: Some(command.to_string()),
                    cwd: Some(r"C:\project".to_string()),
                }),
                ..TaskOutput::default()
            }),
            retry_count: 0,
        };
        let run = CodeProRunResult::from_run(&TaskDAG::new("verify", vec![skipped]), &[]);

        let work = tester_work_from_evidence(&run, &run.tasks.iter().collect::<Vec<_>>());
        let verification = final_verification_by_task(&run);

        assert!(work.contains("宿主"), "{work}");
        assert!(!work.contains("按你的要求"), "{work}");
        assert_eq!(verification[0].verdict, VerificationVerdict::Skipped);
        assert_eq!(verification[0].command.as_deref(), Some(command));
        assert_eq!(verification[0].exit_code, None);
    }

    #[test]
    fn skipped_tester_without_typed_reason_reports_unknown_not_user_choice() {
        use crate::agents::task_dag::{TaskDAG, TaskNode, TaskStatus};

        let skipped = TaskNode {
            id: "dependency-skipped".to_string(),
            name: "依赖后的测试".to_string(),
            description: "not run because a prerequisite did not finish".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: vec!["missing-prerequisite".to_string()],
            acceptance_criteria: "record result".to_string(),
            status: TaskStatus::Skipped,
            output: None,
            retry_count: 0,
        };
        let run = CodeProRunResult::from_run(&TaskDAG::new("verify", vec![skipped]), &[]);

        let work = tester_work_from_evidence(&run, &run.tasks.iter().collect::<Vec<_>>());

        assert!(work.contains("原因未确认"), "{work}");
        assert!(!work.contains("按你的要求"), "{work}");
    }

    #[test]
    fn mixed_not_run_reasons_are_reported_without_collapsing_their_provenance() {
        use crate::agents::codepro_run_result::AggregatedTaskResult;
        use crate::agents::task_dag::{
            TaskOutput, TaskStatus, ValidationNotRunEvidenceV1, ValidationNotRunReasonV1,
            VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
        };

        let skipped = |id: &str, reason: Option<ValidationNotRunReasonV1>| AggregatedTaskResult {
            id: id.to_string(),
            name: id.to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            status: TaskStatus::Skipped,
            current_output: reason.map(|reason| TaskOutput {
                validation_not_run: Some(ValidationNotRunEvidenceV1 {
                    schema_version: VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
                    reason,
                    tool_call_id: None,
                    command: None,
                    cwd: None,
                }),
                ..TaskOutput::default()
            }),
            has_current_evidence: true,
            has_current_verification: false,
        };
        let tasks = [
            skipped("user", Some(ValidationNotRunReasonV1::UserRequested)),
            skipped("host", Some(ValidationNotRunReasonV1::HostBoundary)),
            skipped("unknown", Some(ValidationNotRunReasonV1::Unknown)),
            skipped("legacy", None),
        ];
        let refs = tasks.iter().collect::<Vec<_>>();

        let work = tester_not_run_work(&refs);

        assert!(work.contains("1 项由用户明确选择跳过"), "{work}");
        assert!(work.contains("1 项被宿主有界验证边界跳过"), "{work}");
        assert!(work.contains("2 项原因未确认"), "{work}");
    }

    #[test]
    fn tester_local_not_run_does_not_erase_coder_global_file_evidence() {
        use crate::agents::task_dag::{
            TaskDAG, TaskNode, TaskOutput, TaskStatus, ValidationNotRunEvidenceV1,
            ValidationNotRunReasonV1, VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
        };

        let coder = TaskNode {
            id: "code".to_string(),
            name: "修改实现".to_string(),
            description: "update app.js".to_string(),
            role: crate::agents::agent_role::AgentRole::Coder,
            depends_on: Vec::new(),
            acceptance_criteria: "app.js updated".to_string(),
            status: TaskStatus::Done,
            output: Some(TaskOutput {
                change_report: "app.js 已修改".to_string(),
                files_changed: vec!["app.js".to_string()],
                ..TaskOutput::default()
            }),
            retry_count: 0,
        };
        let tester = TaskNode {
            id: "test".to_string(),
            name: "验证实现".to_string(),
            description: "run bounded validation".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: vec!["code".to_string()],
            acceptance_criteria: "record validation".to_string(),
            status: TaskStatus::Skipped,
            output: Some(TaskOutput {
                change_report: "本子任务未修改文件".to_string(),
                test_results: Some("result:NOT_RUN".to_string()),
                validation_not_run: Some(ValidationNotRunEvidenceV1 {
                    schema_version: VALIDATION_NOT_RUN_EVIDENCE_SCHEMA_VERSION,
                    reason: ValidationNotRunReasonV1::HostBoundary,
                    tool_call_id: Some("call-test".to_string()),
                    command: Some("node -e unsafe".to_string()),
                    cwd: Some(r"C:\project".to_string()),
                }),
                ..TaskOutput::default()
            }),
            retry_count: 0,
        };
        let run = CodeProRunResult::from_run(&TaskDAG::new("repair", vec![coder, tester]), &[]);
        let results =
            agent_results_from_run(&run, &run.current_files, &final_verification_by_task(&run));

        assert_eq!(run.current_files, vec!["app.js"]);
        assert!(results
            .iter()
            .find(|result| result.agent == "编码 Agent")
            .is_some_and(|result| result.work.contains("app.js")));
        assert!(results
            .iter()
            .find(|result| result.agent == "测试 Agent")
            .is_some_and(|result| result.work.contains("宿主")));
    }

    #[test]
    fn bounded_not_run_report_preserves_the_requested_command() {
        use crate::agents::task_dag::{TaskDAG, TaskNode, TaskOutput, TaskStatus};

        let command = r#"start /b "D:\test\.venv\Scripts\python.exe" app.py"#;
        let skipped = TaskNode {
            id: "host-fallback-verify".to_string(),
            name: "独立验证用户目标".to_string(),
            description: "bounded validation".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "record NOT_RUN".to_string(),
            status: TaskStatus::Skipped,
            output: Some(TaskOutput {
                patch: String::new(),
                change_report: "静态分析已完成".to_string(),
                test_results: Some(format!(
                    "命令：{command}\n工作目录：D:\\test\n结果：动态验证未运行\n退出码：NOT_RUN\nresult:NOT_RUN"
                )),
                files_changed: Vec::new(),
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let dag = TaskDAG::new("静态分析", vec![skipped]);
        let run = CodeProRunResult::from_run(&dag, &[]);

        let summary = final_verification_by_task(&run);

        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].verdict, VerificationVerdict::Skipped);
        assert_eq!(summary[0].command.as_deref(), Some(command));
        assert_eq!(summary[0].exit_code, None);
    }

    fn facts_with_evidence(
        outcome: CodeProTerminalOutcome,
        completion_allowed: bool,
    ) -> CodeProReportFacts {
        let evidence = [
            ReportEvidence {
                id: "run-state".to_string(),
                kind: ReportEvidenceKind::RunState,
                label: "outcome".to_string(),
                value: "failed".to_string(),
            },
            ReportEvidence {
                id: "file-1".to_string(),
                kind: ReportEvidenceKind::File,
                label: "changed_file".to_string(),
                value: "src/main.rs".to_string(),
            },
            ReportEvidence {
                id: "verify-1".to_string(),
                kind: ReportEvidenceKind::Verification,
                label: "test-task".to_string(),
                value: "failed".to_string(),
            },
            ReportEvidence {
                id: "limitation-1".to_string(),
                kind: ReportEvidenceKind::Limitation,
                label: "limitation".to_string(),
                value: "review_unavailable".to_string(),
            },
        ]
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect();
        CodeProReportFacts {
            outcome,
            task_kind: "fix".to_string(),
            risk_tier: CodeProRiskTier::L3HighRiskRelease,
            risk_reasons: vec![CodeProRiskReason::PermissionBoundary],
            review_required: true,
            completion_allowed,
            locale: "zh-CN".to_string(),
            trusted_project_root: Some(PathBuf::from("D:/project")),
            changed_files: vec!["src/main.rs".to_string()],
            verification_summary: vec![VerificationSummary {
                task_id: "test-task".to_string(),
                verdict: VerificationVerdict::Failed,
                command: Some("cargo test".to_string()),
                exit_code: Some(1),
                evidence_ref: "verify-1".to_string(),
            }],
            reviewer_approved: false,
            limitations: vec!["review_unavailable".to_string()],
            recovery_action: ReportRecoveryAction::RetryReview,
            classification_counts: ClassificationCounts {
                test_failure: 1,
                codepro_incomplete: 1,
                ..ClassificationCounts::default()
            },
            evidence,
            agent_results: Vec::new(),
        }
    }

    #[test]
    fn wire_enums_use_closed_snake_case_values() {
        let outcomes = [
            (CodeProTerminalOutcome::Completed, "completed"),
            (CodeProTerminalOutcome::Skipped, "skipped"),
            (CodeProTerminalOutcome::Partial, "partial"),
            (CodeProTerminalOutcome::Paused, "paused"),
            (CodeProTerminalOutcome::WaitingForUser, "waiting_for_user"),
            (CodeProTerminalOutcome::Cancelled, "cancelled"),
            (CodeProTerminalOutcome::PlanningFailed, "planning_failed"),
            (
                CodeProTerminalOutcome::SchedulingFailed,
                "scheduling_failed",
            ),
            (CodeProTerminalOutcome::ReviewFailed, "review_failed"),
            (CodeProTerminalOutcome::Failed, "failed"),
        ];
        for (value, expected) in outcomes {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(expected));
        }

        let recovery_actions = [
            (ReportRecoveryAction::None, "none"),
            (ReportRecoveryAction::RetryPlanning, "retry_planning"),
            (
                ReportRecoveryAction::ContinueCheckpoint,
                "continue_checkpoint",
            ),
            (ReportRecoveryAction::AskUser, "ask_user"),
            (ReportRecoveryAction::RetryValidation, "retry_validation"),
            (ReportRecoveryAction::RetryReview, "retry_review"),
            (
                ReportRecoveryAction::SelectProjectDirectory,
                "select_project_directory",
            ),
            (ReportRecoveryAction::ManualReview, "manual_review"),
        ];
        for (value, expected) in recovery_actions {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(expected));
        }
    }

    #[test]
    fn structured_payload_uses_the_terminal_contract_keys() {
        let payload = CodeProTerminalReportPayload {
            outcome: CodeProTerminalOutcome::PlanningFailed,
            classification_counts: ClassificationCounts {
                codepro_incomplete: 1,
                ..ClassificationCounts::default()
            },
            changed_files: Vec::new(),
            verification_summary: Vec::new(),
            limitations: vec!["planning_unavailable".to_string()],
            recovery_action: ReportRecoveryAction::RetryPlanning,
            risk_tier: Some(CodeProRiskTier::L2Feature),
            risk_reasons: vec![CodeProRiskReason::MultiFileOrUnknownWriteScope],
            review_required: false,
        };

        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            json!({
                "outcome": "planning_failed",
                "classification_counts": {
                    "confirmed_bug": 0,
                    "test_failure": 0,
                    "environment_problem": 0,
                    "codepro_incomplete": 1,
                    "unverified": 0
                },
                "changed_files": [],
                "verification_summary": [],
                "limitations": ["planning_unavailable"],
                "recovery_action": "retry_planning",
                "risk_tier": "l2_feature",
                "risk_reasons": ["multi_file_or_unknown_write_scope"],
                "review_required": false
            })
        );
    }

    #[test]
    fn legacy_terminal_payload_without_risk_fields_remains_readable() {
        let payload: CodeProTerminalReportPayload = serde_json::from_value(json!({
            "outcome": "failed",
            "classification_counts": {
                "confirmed_bug": 0,
                "test_failure": 0,
                "environment_problem": 0,
                "codepro_incomplete": 1,
                "unverified": 0
            },
            "changed_files": [],
            "verification_summary": [],
            "limitations": [],
            "recovery_action": "manual_review"
        }))
        .unwrap();

        assert_eq!(payload.risk_tier, None);
        assert!(payload.risk_reasons.is_empty());
        assert!(!payload.review_required);
    }

    #[test]
    fn planner_fallback_limitations_explain_clarification_and_fail_closed_outcomes() {
        assert_eq!(
            limitation_text("planning_requires_clarification"),
            "规划仍缺少可安全决定实现方向的信息，请补充目标或范围。"
        );
        assert_eq!(
            limitation_text("planning_failed_closed"),
            "高风险任务的规划纠错仍失败，CodePro 已停止且没有降级执行。"
        );
    }

    #[test]
    fn pause_limitations_render_as_human_readable_text() {
        assert_eq!(
            limitation_text("recovery_paused"),
            "恢复上次任务时暂停；当前报告没有证明已提交可恢复检查点。"
        );
        assert_eq!(
            limitation_text("checkpoint_paused"),
            "任务已暂停，进度已保存为检查点，可继续未完成步骤。"
        );
        assert_eq!(
            limitation_text("legacy_unclassified"),
            "历史任务的暂停原因未记录，进度已保留。"
        );
    }

    #[test]
    fn internal_recovery_codes_never_leak_into_the_user_report() {
        for code in [
            "task_failure",
            "verification_recovery_failed",
            "repair_branch_unavailable",
        ] {
            let rendered = limitation_text(code);
            assert!(!rendered.contains(code));
            assert!(!rendered.contains("仍有限制"));
        }

        let unknown = limitation_text("future_internal_status_code");
        assert!(!unknown.contains("future_internal_status_code"));
        assert!(!unknown.contains("future internal status code"));
        assert!(!unknown.contains("仍有限制"));
    }

    #[test]
    fn report_draft_rejects_unknown_schema_versions() {
        let error = serde_json::from_value::<ReportDraftV1>(json!({
            "schema_version": 2,
            "summary": "summary",
            "changes": [],
            "verification": [],
            "limitations": [],
            "next_step": null
        }))
        .unwrap_err();

        assert!(error.to_string().contains("schema_version must be 1"));
    }

    #[test]
    fn final_verification_is_one_verdict_per_acceptance_task() {
        let mut run = empty_run();
        run.verification_groups = vec![
            verification_group(
                "test-task",
                "cargo test old",
                VerificationOutcome::TestFailed,
            ),
            verification_group("test-task", "cargo test", VerificationOutcome::Passed),
        ];

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].task_id, "test-task");
        assert_eq!(summaries[0].verdict, VerificationVerdict::Unverified);
    }

    #[test]
    fn final_verification_maps_a_current_pass_and_keeps_old_attempts_technical() {
        let mut group = verification_group("test-task", "cargo test", VerificationOutcome::Passed);
        group.history.push(VerificationAttempt {
            outcome: VerificationOutcome::TestFailed,
            evidence: "old failure".to_string(),
            exit_code: Some(1),
        });
        let mut run = empty_run();
        run.verification_groups = vec![group];

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].verdict, VerificationVerdict::Passed);
        assert_eq!(summaries[0].command.as_deref(), Some("cargo test"));
    }

    #[test]
    fn final_verification_keeps_latest_command_for_multiple_successful_checks() {
        let mut first =
            verification_group("test-task", "go test ./...", VerificationOutcome::Passed);
        first.current.exit_code = Some(0);
        let mut second =
            verification_group("test-task", "go test -v ./...", VerificationOutcome::Passed);
        second.current.exit_code = Some(0);
        let mut run = empty_run();
        run.verification_groups = vec![first, second];

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].verdict, VerificationVerdict::Passed);
        assert_eq!(summaries[0].command.as_deref(), Some("go test -v ./..."));
        assert_eq!(summaries[0].exit_code, Some(0));
    }

    #[test]
    fn partial_desktop_task_cannot_render_its_partial_evidence_as_passed() {
        use crate::agents::task_dag::{
            TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
            VerificationOutcomeV1,
        };

        let task = TaskNode {
            id: "desktop-acceptance".to_string(),
            name: "desktop acceptance".to_string(),
            description: "complete the user flow".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "computer_focus then computer_type".to_string(),
            status: TaskStatus::Paused,
            output: Some(TaskOutput::default()),
            retry_count: 0,
        };
        let mut dag = TaskDAG::new("desktop acceptance", vec![task]);
        dag.record_verification(
            "desktop-acceptance",
            VerificationEvidenceV1 {
                schema_version: 1,
                assertion_id: "focus-only".to_string(),
                expected: "foreground window".to_string(),
                observed_summary: "focus worked".to_string(),
                exit_code: None,
                outcome: VerificationOutcomeV1::Passed,
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
                tool_ref: "computer_focus".to_string(),
                failure_epoch: 0,
                execution_outcome: crate::agents::task_dag::ExecutionOutcome::Succeeded,
                repair_context: None,
            },
        )
        .unwrap();
        let run = CodeProRunResult::from_run(&dag, &[]);

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].verdict, VerificationVerdict::Unverified);
        assert_eq!(summaries[0].exit_code, None);
    }

    #[test]
    fn final_verification_prefers_typed_ledger_and_preserves_exit_code() {
        use crate::agents::task_dag::{
            TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
            VerificationOutcomeV1,
        };

        let task = TaskNode {
            id: "test-task".to_string(),
            name: "test".to_string(),
            description: "verify".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "tests pass".to_string(),
            status: TaskStatus::Failed,
            output: Some(TaskOutput {
                patch: String::new(),
                change_report: "legacy says pass".to_string(),
                test_results: Some("缁撴灉锛氶€氳繃".to_string()),
                files_changed: Vec::new(),
                validation_not_run: None,
                usage: None,
            }),
            retry_count: 0,
        };
        let mut dag = TaskDAG::new("verify", vec![task]);
        dag.record_verification(
            "test-task",
            VerificationEvidenceV1 {
                schema_version: 1,
                assertion_id: "assertion-a".to_string(),
                expected: "exit_code:0".to_string(),
                observed_summary: "exit_code:1".to_string(),
                exit_code: Some(1),
                outcome: VerificationOutcomeV1::Failed,
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
                tool_ref: "tool-response".to_string(),
                failure_epoch: 0,
                execution_outcome: crate::agents::task_dag::ExecutionOutcome::VerificationFailed,
                repair_context: None,
            },
        )
        .unwrap();
        let run = CodeProRunResult::from_run(&dag, &[]);

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].verdict, VerificationVerdict::Failed);
        assert_eq!(summaries[0].exit_code, Some(1));
        assert_eq!(summaries[0].command, None);
    }

    #[test]
    fn final_verification_reads_the_command_from_typed_repair_context() {
        use crate::agents::task_dag::{
            RepairContext, TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
            VerificationOutcomeV1,
        };

        let task = TaskNode {
            id: "test-task".to_string(),
            name: "test".to_string(),
            description: "verify".to_string(),
            role: crate::agents::agent_role::AgentRole::Tester,
            depends_on: Vec::new(),
            acceptance_criteria: "tests pass".to_string(),
            status: TaskStatus::Done,
            output: Some(TaskOutput::default()),
            retry_count: 0,
        };
        let mut dag = TaskDAG::new("verify", vec![task]);
        let repair_context = RepairContext {
            command: r#"C:\tools\node.exe tests.js"#.to_string(),
            ..RepairContext::default()
        };
        dag.record_verification(
            "test-task",
            VerificationEvidenceV1 {
                schema_version: 1,
                assertion_id: "assertion-a".to_string(),
                expected: "exit_code:0".to_string(),
                observed_summary: "exit_code:0".to_string(),
                exit_code: Some(0),
                outcome: VerificationOutcomeV1::Passed,
                artifact_sha256: None,
                recorded_at: chrono::Utc::now(),
                tool_ref: "host_verification_v1".to_string(),
                failure_epoch: 0,
                execution_outcome: crate::agents::task_dag::ExecutionOutcome::Succeeded,
                repair_context: Some(repair_context),
            },
        )
        .unwrap();
        let run = CodeProRunResult::from_run(&dag, &[]);

        let summaries = final_verification_by_task(&run);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].verdict, VerificationVerdict::Passed);
        assert_eq!(
            summaries[0].command.as_deref(),
            Some(r#"C:\tools\node.exe tests.js"#)
        );
    }

    #[test]
    fn authoritative_non_terminal_convergence_cannot_render_completed() {
        let run = empty_run();
        let assessment = ConvergenceAssessment {
            status: ConvergenceStatus::Blocked,
            ready_task_ids: Vec::new(),
            blockers: Vec::new(),
        };

        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: None,
            run_status: CodeProRunStatus::Completed,
            convergence: Some(&assessment),
            run: &run,
            trusted_project_root: None,
            task_kind: "fix",
            risk_assessment: &risk_assessment(CodeProRiskTier::L3HighRiskRelease),
            reviewer_approved: true,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::None,
        });

        assert_eq!(facts.outcome, CodeProTerminalOutcome::Failed);
        assert!(!facts.completion_allowed);
    }

    #[test]
    fn changed_files_are_relative_to_the_trusted_evidence_root() {
        let root = std::env::temp_dir().join(format!("codepro-report-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(root.join("src")).unwrap();
        let mut run = empty_run();
        run.current_files = vec![
            root.join("src/main.rs").display().to_string(),
            "src/lib.rs".to_string(),
            "../outside.rs".to_string(),
        ];

        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::Partial),
            run_status: CodeProRunStatus::Failed,
            convergence: None,
            run: &run,
            trusted_project_root: Some(&root),
            task_kind: "fix",
            risk_assessment: &risk_assessment(CodeProRiskTier::L3HighRiskRelease),
            reviewer_approved: false,
            limitations: Vec::new(),
            recovery_action: ReportRecoveryAction::ManualReview,
        });

        assert_eq!(facts.changed_files, vec!["src/main.rs", "src/lib.rs"]);
        assert!(facts
            .limitations
            .iter()
            .any(|value| value == "out_of_workspace_operation"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planning_failure_selects_safe_host_facts() {
        let run = empty_run();
        let facts = build_report_facts(ReportFactsInput {
            requested_outcome: Some(CodeProTerminalOutcome::PlanningFailed),
            run_status: CodeProRunStatus::Failed,
            convergence: None,
            run: &run,
            trusted_project_root: None,
            task_kind: "fix",
            risk_assessment: &risk_assessment(CodeProRiskTier::L3HighRiskRelease),
            reviewer_approved: false,
            limitations: vec!["planning_unavailable".to_string()],
            recovery_action: ReportRecoveryAction::RetryPlanning,
        });

        assert_eq!(facts.outcome, CodeProTerminalOutcome::PlanningFailed);
        assert!(facts.changed_files.is_empty());
        assert_eq!(facts.recovery_action, ReportRecoveryAction::RetryPlanning);
        assert_eq!(facts.classification_counts.codepro_incomplete, 1);
    }

    #[test]
    fn visible_report_names_the_trusted_project_location() {
        let mut facts = facts_with_evidence(CodeProTerminalOutcome::Completed, true);
        facts.trusted_project_root = Some(PathBuf::from("D:/codepro-project-15"));

        let markdown = render_report(&facts, &fallback_draft(&facts));
        let visible = markdown.split("<details>").next().unwrap_or(&markdown);

        assert!(
            visible.contains("项目位置：D:/codepro-project-15。"),
            "{visible}"
        );
    }

    #[test]
    fn agent_report_names_real_work_and_omits_nonparticipants_and_empty_markers() {
        use crate::agents::agent_role::AgentRole;

        let mut run = empty_run();
        run.tasks = vec![
            done_task("plan", AgentRole::Planner),
            done_task("implement", AgentRole::Coder),
            done_task("verify", AgentRole::Tester),
        ];
        run.current_files = vec!["index.html".to_string()];
        run.verification_groups = vec![verification_group(
            "verify",
            "type index.html",
            VerificationOutcome::Passed,
        )];
        run.verification_groups[0].current.exit_code = Some(0);

        let verification = final_verification_by_task(&run);
        let results = agent_results_from_run(&run, &["index.html".to_string()], &verification);
        let rendered = results
            .iter()
            .map(|item| format!("{}\n{}\n{}", item.agent, item.work, item.result))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("分析 Agent"), "{rendered}");
        assert!(rendered.contains("编码 Agent"), "{rendered}");
        assert!(rendered.contains("测试 Agent"), "{rendered}");
        assert!(!rendered.contains("审查 Agent"), "{rendered}");
        assert!(rendered.contains("index.html"), "{rendered}");
        assert!(rendered.contains("最终验证通过"), "{rendered}");
        assert!(rendered.contains("仅代表已执行的检查范围"), "{rendered}");
        assert!(!rendered.contains("这部分工作"), "{rendered}");
        assert!(!rendered.contains("相关验证"), "{rendered}");
        assert!(!rendered.contains("确认 Bug"), "{rendered}");
        assert!(!rendered.contains("NOT_RUN"), "{rendered}");
    }

    #[test]
    fn coder_without_file_evidence_does_not_claim_writes_or_resumability() {
        use crate::agents::{agent_role::AgentRole, task_dag::TaskStatus};

        for status in [
            TaskStatus::Done,
            TaskStatus::Paused,
            TaskStatus::WaitingForUser,
        ] {
            let mut run = empty_run();
            let mut task = done_task("implement", AgentRole::Coder);
            task.status = status;
            run.tasks = vec![task];
            let result = agent_results_from_run(&run, &[], &[]).remove(0);
            assert_eq!(result.work, "未记录到项目文件改动。");
            assert!(!result.result.contains("修改已经保存"));
            assert!(!result.result.contains("从原步骤继续"));
        }
    }

    #[test]
    fn tester_without_verification_evidence_never_claims_success() {
        use crate::agents::agent_role::AgentRole;

        let mut run = empty_run();
        run.tasks = vec![done_task("verify", AgentRole::Tester)];

        let results = agent_results_from_run(&run, &[], &[]);
        let tester = results.first().expect("tester result");

        assert!(!tester.result.contains("通过"), "{}", tester.result);
        assert!(tester.work.contains("尚未取得测试执行证据"));
        assert!(
            tester.result.contains("没有取得可确认的测试结果"),
            "{}",
            tester.result
        );
    }

    #[test]
    fn tester_report_names_the_actual_check_and_limits_success_to_its_scope() {
        use crate::agents::agent_role::AgentRole;

        let mut run = empty_run();
        let mut tester = done_task("verify", AgentRole::Tester);
        tester.name = "读取并验证 index.html 可读性与内容".to_string();
        run.tasks = vec![tester];
        run.verification_groups = vec![verification_group(
            "verify",
            "type index.html",
            VerificationOutcome::Passed,
        )];
        run.verification_groups[0].current.exit_code = Some(0);

        let verification = final_verification_by_task(&run);
        let results = agent_results_from_run(&run, &[], &verification);
        let tester = results.first().expect("tester result");

        assert!(
            tester.work.contains("读取并验证 index.html 可读性与内容"),
            "{}",
            tester.work
        );
        assert!(tester.result.contains("最终验证通过"), "{}", tester.result);
        assert!(
            tester.result.contains("仅代表已执行的检查范围"),
            "{}",
            tester.result
        );
        assert!(!tester.result.contains("没有发现 Bug"), "{}", tester.result);
        assert_ne!(tester.work, "检查了任务结果是否符合你的要求。");
    }

    #[test]
    fn checkpoint_input_tester_report_distinguishes_waiting_skipped_and_partial_execution() {
        use crate::agents::{agent_role::AgentRole, task_dag::TaskStatus};

        for status in [
            TaskStatus::WaitingForUser,
            TaskStatus::Paused,
            TaskStatus::Skipped,
        ] {
            let mut run = empty_run();
            let mut pending = done_task("waiting", AgentRole::Tester);
            pending.name = "尚未执行的测试".to_string();
            pending.status = status;
            run.tasks.push(pending);
            let result = agent_results_from_run(&run, &[], &[]).remove(0);
            assert!(!result.work.contains("实际执行了"));
            assert!(!result.result.contains("检查通过"));
            if status == TaskStatus::Skipped {
                assert!(result.work.contains("未执行测试命令"));
                assert!(result.result.contains("未运行"));
            } else {
                assert!(result.work.contains("尚未取得测试执行证据"));
            }

            let mut executed = done_task("executed", AgentRole::Tester);
            executed.name = "加法检查".to_string();
            run.tasks.push(executed);
            let mut evidence =
                verification_group("executed", "node tests.js", VerificationOutcome::Passed);
            evidence.current.exit_code = Some(0);
            run.verification_groups.push(evidence);
            let verification = final_verification_by_task(&run);
            let result = agent_results_from_run(&run, &[], &verification).remove(0);
            assert!(result.work.contains("加法检查"));
            assert!(!result.work.contains("尚未执行的测试"));
            assert!(result.work.contains("不计为完成"));
            assert!(!result.result.contains("检查通过"));
            assert_eq!(verification[0].verdict, VerificationVerdict::Passed);
        }
    }

    #[test]
    fn checkpoint_input_tester_report_keeps_actual_failure_and_rejects_unexecuted_pass_claim() {
        use crate::agents::agent_role::AgentRole;
        let mut run = empty_run();
        run.tasks.push(done_task("verify", AgentRole::Tester));
        run.verification_groups.push(verification_group(
            "verify",
            "node tests.js",
            VerificationOutcome::Passed,
        ));
        let result = agent_results_from_run(&run, &[], &final_verification_by_task(&run)).remove(0);
        assert!(result.work.contains("尚未取得测试执行证据"));
        assert!(!result.result.contains("没有发现 Bug"));
        run.verification_groups[0].current.outcome = VerificationOutcome::TestFailed;
        run.verification_groups[0].current.exit_code = Some(1);
        let result = agent_results_from_run(&run, &[], &final_verification_by_task(&run)).remove(0);
        assert!(result.work.contains("已执行"));
        assert!(result.result.contains("检查没有通过"));
    }

    #[test]
    fn fallback_preserves_every_limitation_and_renders_structured_sections() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::ReviewFailed, false);

        let draft = fallback_draft(&facts);
        validate_draft(&facts, &draft).unwrap();
        let markdown = render_report(&facts, &draft);

        assert!(markdown.starts_with("# 任务报告"));
        assert!(markdown.contains("## 执行 Agent"));
        assert!(markdown.contains("做了什么："));
        assert!(markdown.contains("结果："));
        assert!(markdown.contains("## 总结"));
        assert!(markdown.contains("### 接下来需要你做什么"));
        assert!(markdown.contains("独立审查"));
        assert!(markdown.contains("<details>"));
        assert!(markdown.contains("<summary>技术详情</summary>"));
    }

    #[test]
    fn empty_model_verification_uses_trusted_host_verification() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.verification.clear();

        let markdown = render_report(&facts, &draft);
        let visible = markdown.split("<details>").next().unwrap_or(&markdown);

        assert!(visible.contains("相关验证未通过"), "{visible}");
        assert!(!visible.contains("test-task"), "{visible}");
        assert!(!visible.contains("没有运行验证"), "{visible}");
    }

    #[test]
    fn failed_test_is_reported_as_verification_not_as_a_limitation() {
        let mut facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        facts.limitations.clear();
        facts
            .evidence
            .retain(|_, evidence| evidence.kind != ReportEvidenceKind::Limitation);
        facts.recovery_action = ReportRecoveryAction::RetryValidation;

        let draft = fallback_draft(&facts);
        let markdown = render_report(&facts, &draft);

        let visible = markdown.split("<details>").next().unwrap_or(&markdown);
        assert!(visible.contains("相关验证未通过"));
        assert!(!visible.contains("test-task"));
        assert!(!visible.contains("cargo test"));
        assert!(markdown.contains("`cargo test`"));
        assert!(!markdown.contains("### 尚未完成"));
        assert!(!markdown.contains("仍有限制"));
        assert!(!markdown.contains("- 限制："));
        assert!(!markdown.contains("验证结果和限制"));
    }

    #[test]
    fn visible_report_uses_plain_language_and_keeps_status_codes_in_technical_details() {
        let mut facts = facts_with_evidence(CodeProTerminalOutcome::Skipped, false);
        facts.verification_summary[0].verdict = VerificationVerdict::Skipped;
        facts.limitations.clear();
        facts
            .evidence
            .retain(|_, evidence| evidence.kind != ReportEvidenceKind::Limitation);

        let markdown = render_report(&facts, &fallback_draft(&facts));
        let (visible, technical) = markdown.split_once("<details>").unwrap();

        assert!(visible.contains("没有运行动态测试"), "{visible}");
        assert!(!visible.contains("NOT_RUN"), "{visible}");
        assert!(!visible.contains("Reviewer"), "{visible}");
        assert!(!visible.contains("执行级别"), "{visible}");
        assert!(!visible.contains("限制"), "{visible}");
        assert!(!visible.contains("cargo test"), "{visible}");
        assert!(technical.contains("终态：NOT_RUN"), "{technical}");
        assert!(technical.contains("cargo test"), "{technical}");
    }

    #[test]
    fn validator_requires_exactly_one_result_sentence() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.summary = "第一句话。第二句话。".to_string();

        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::TooLarge)
        ));
    }

    #[test]
    fn validator_rejects_unknown_and_section_incompatible_evidence() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.changes[0].evidence_refs = vec!["missing".to_string()];
        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::UnknownEvidence(_))
        ));

        draft.changes[0].evidence_refs = vec!["verify-1".to_string()];
        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::IncompatibleEvidence { .. })
        ));
    }

    #[test]
    fn validator_rejects_false_completion_pass_and_approval_claims() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.summary = "任务已完成，测试全部通过，Reviewer 已批准。".to_string();

        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::ForbiddenClaim(_))
        ));
    }

    #[test]
    fn validator_rejects_internal_status_codes_from_visible_report_text() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Skipped, false);
        let mut draft = fallback_draft(&facts);
        draft.summary = "动态验证 NOT_RUN。".to_string();

        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::ForbiddenClaim(
                "internal_status_code"
            ))
        ));
    }

    #[test]
    fn validator_requires_all_host_limitations() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::ReviewFailed, false);
        let mut draft = fallback_draft(&facts);
        draft.limitations.clear();

        assert!(matches!(
            validate_draft(&facts, &draft),
            Err(ReportValidationError::MissingLimitation(_))
        ));
    }

    #[test]
    fn renderer_escapes_model_markdown_and_html() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.summary = "# heading <script>alert(1)</script> ```code```".to_string();
        let markdown = render_report(&facts, &draft);

        assert!(!markdown.contains("<script>"));
        assert!(!markdown.contains("```code```"));
        assert!(markdown.contains("&lt;script&gt;"));
    }

    #[test]
    fn terminal_payload_contains_only_host_structured_facts() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);

        let payload = terminal_payload(&facts);

        assert_eq!(payload.outcome, CodeProTerminalOutcome::Failed);
        assert_eq!(payload.changed_files, vec!["src/main.rs"]);
        assert_eq!(payload.verification_summary.len(), 1);
        assert_eq!(payload.limitations, vec!["review_unavailable"]);
        assert_eq!(payload.recovery_action, ReportRecoveryAction::RetryReview);
    }

    #[test]
    fn fallback_coalesces_more_than_five_limitations_without_dropping_evidence() {
        let mut facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        facts.limitations = (1..=7).map(|index| format!("limit_{index}")).collect();
        facts
            .evidence
            .retain(|_, evidence| evidence.kind != ReportEvidenceKind::Limitation);
        for (index, limitation) in facts.limitations.iter().enumerate() {
            let id = format!("limitation-{}", index + 1);
            facts.evidence.insert(
                id.clone(),
                ReportEvidence {
                    id,
                    kind: ReportEvidenceKind::Limitation,
                    label: "limitation".to_string(),
                    value: limitation.clone(),
                },
            );
        }

        let draft = fallback_draft(&facts);

        assert_eq!(draft.limitations.len(), 5);
        assert_eq!(draft.limitations[4].evidence_refs.len(), 3);
        validate_draft(&facts, &draft).unwrap();
    }

    #[test]
    fn rewrite_cannot_supply_its_own_numbers_paths_or_commands() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        for invented in [
            "修改了 9 个文件。",
            "修改了 other/secret.rs。",
            "运行 cargo test 并得到结论。",
        ] {
            let mut draft = fallback_draft(&facts);
            draft.changes[0].text = invented.to_string();
            assert!(matches!(
                validate_rewrite_draft(&facts, &draft),
                Err(ReportValidationError::ForbiddenClaim(_))
            ));
        }
    }

    #[test]
    fn renderer_adds_exact_host_file_and_verification_details() {
        let facts = facts_with_evidence(CodeProTerminalOutcome::Failed, false);
        let mut draft = fallback_draft(&facts);
        draft.changes[0].text = "修正了相关实现。".to_string();
        draft.verification[0].text = "最终检查没有通过。".to_string();

        let markdown = render_report(&facts, &draft);
        let (visible, technical) = markdown.split_once("<details>").unwrap();

        assert!(markdown.contains("`src/main.rs`"));
        assert!(!visible.contains("cargo test"));
        assert!(technical.contains("`cargo test`"));
    }

    #[test]
    fn unavailable_verification_without_a_command_does_not_claim_an_unrecorded_run() {
        let mut facts = facts_with_evidence(CodeProTerminalOutcome::Paused, false);
        facts.verification_summary[0].verdict = VerificationVerdict::Unavailable;
        facts.verification_summary[0].command = None;

        let markdown = render_report(&facts, &fallback_draft(&facts));

        assert!(markdown.contains("未执行（测试入口或环境不可用）"));
        assert!(!markdown.contains("未记录命令"));
    }
}
