use crate::agents::agent_role::AgentRole;
use crate::agents::agent_role::CodeProRiskTier;
use crate::agents::task_dag::{
    ExecutionOutcome, TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
    VerificationOutcomeV1,
};
use crate::agents::task_scheduler::TaskScheduler;
use crate::permission::failure_semantics::CodeProFailureKind;
use std::collections::{BTreeMap, HashSet};

const HOST_INPUT_EXECUTION_LINK: &str = "host_input_execution_link_v1:";
const HOST_INPUT_EXECUTION_HASH: &str = ";host_input_link_sha256:";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostInputExecutionLinkV1 {
    run_id: String,
    question_assertion_id: String,
    execution_assertion_id: String,
    execution_command_sha256: String,
    resolution: super::protocol::UserInputResolution,
}

impl HostInputExecutionLinkV1 {
    pub(super) fn from_verified_dispatch(task: &TaskNode, run_id: &str) -> Option<Self> {
        let text = task.output.as_ref()?.test_results.as_deref()?;
        if text
            .lines()
            .filter(|line| line.starts_with("host_input_committed:"))
            .count()
            != 1
        {
            return None;
        }
        let resolution = super::agent::committed_checkpoint_input(task)?;
        if resolution.validate().is_err()
            || resolution.format_version != 1
            || resolution.skip
            || resolution.task_id.as_str() != task.id
            || resolution.question_checkpoint_id != TaskScheduler::checkpoint_id(task)
            || resolution.execution_payload_sha256
                != super::agent::checkpoint_input_answer_hash(&task.description)
        {
            return None;
        }
        let record: serde_json::Value =
            serde_json::from_str(text.strip_prefix("user_input_required\n")?.lines().next()?)
                .ok()?;
        if record["task_id"].as_str() != Some(task.id.as_str()) {
            return None;
        }
        let question_id = record["input"]["question"]["elicitation_id"].as_str()?;
        uuid::Uuid::parse_str(question_id).ok()?;
        Some(Self {
            run_id: run_id.to_string(),
            question_assertion_id: format!("user-input:{question_id}"),
            execution_assertion_id: String::new(),
            execution_command_sha256: String::new(),
            resolution,
        })
    }

    pub(super) fn attach(
        mut self,
        output: &mut TaskOutput,
        execution: &mut VerificationEvidenceV1,
    ) -> anyhow::Result<()> {
        if execution.tool_ref != "host_verification_v1" || execution.exit_code.is_none() {
            return Ok(());
        }
        self.execution_assertion_id = execution.assertion_id.clone();
        let Some(context) = execution.repair_context.as_ref() else {
            return Ok(());
        };
        self.execution_command_sha256 =
            super::agent::checkpoint_input_answer_hash(&context.command);
        let record = serde_json::to_string(&self)?;
        anyhow::ensure!(
            !execution
                .observed_summary
                .contains(HOST_INPUT_EXECUTION_HASH),
            "duplicate host execution input fingerprint"
        );
        execution.observed_summary.push_str(&format!(
            "{HOST_INPUT_EXECUTION_HASH}{}",
            super::agent::checkpoint_input_answer_hash(&record)
        ));
        let text = output.test_results.get_or_insert_with(String::new);
        anyhow::ensure!(
            !text
                .lines()
                .any(|line| line.starts_with(HOST_INPUT_EXECUTION_LINK)),
            "duplicate host input execution link"
        );
        text.push_str(&format!("\n{HOST_INPUT_EXECUTION_LINK}{record}"));
        Ok(())
    }
}

pub(crate) const MAX_TEST_REPAIR_ATTEMPTS: usize = 2;

const MAX_RETRY_HISTORY_PER_VERIFICATION: usize = 3;

#[derive(Debug, Clone)]
pub(crate) struct CodeProRunResult {
    pub(crate) diagnostic_tasks: HashSet<String>,
    pub(crate) tasks: Vec<AggregatedTaskResult>,
    pub(crate) verification_groups: Vec<VerificationGroup>,
    pub(crate) current_files: Vec<String>,
    pub(crate) review_summaries: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AggregatedTaskResult {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) role: AgentRole,
    pub(crate) status: TaskStatus,
    pub(crate) current_output: Option<TaskOutput>,
    pub(crate) has_current_evidence: bool,
    pub(crate) has_current_verification: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct VerificationGroup {
    pub(crate) task_id: String,
    pub(crate) key: String,
    pub(crate) current: VerificationAttempt,
    pub(crate) history: Vec<VerificationAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerificationAttempt {
    pub(crate) outcome: VerificationOutcome,
    pub(crate) evidence: String,
    pub(crate) exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerificationOutcome {
    Passed,
    TestFailed,
    CheckFailed,
    EnvironmentUnavailable,
    CommandFailed,
    NoTests,
    Completed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeProRecoveryDecision {
    Proceed,
    RepairThenRetest,
    RetryTest,
    RevisePlanWithinScope,
    AskUser,
    PauseCheckpoint,
    StopDenied,
    StopCancelled,
    FinishFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CodeProRecoveryContext {
    pub(crate) role: AgentRole,
    pub(crate) status: TaskStatus,
    pub(crate) verification: Option<VerificationOutcome>,
    pub(crate) failure_kind: Option<CodeProFailureKind>,
    pub(crate) risk_tier: CodeProRiskTier,
    pub(crate) repair_attempts: usize,
    pub(crate) has_remaining_budget: bool,
    pub(crate) plan_invalid: bool,
    pub(crate) scope_expansion_required: bool,
}

pub(crate) fn codepro_recovery_decision(
    context: &CodeProRecoveryContext,
) -> CodeProRecoveryDecision {
    match context.status {
        TaskStatus::Cancelled => return CodeProRecoveryDecision::StopCancelled,
        TaskStatus::Paused => return CodeProRecoveryDecision::PauseCheckpoint,
        TaskStatus::WaitingForUser => return CodeProRecoveryDecision::AskUser,
        _ => {}
    }
    match context.failure_kind {
        Some(CodeProFailureKind::PolicyDenied) => {
            return if context.has_remaining_budget {
                CodeProRecoveryDecision::RevisePlanWithinScope
            } else {
                CodeProRecoveryDecision::StopDenied
            };
        }
        Some(CodeProFailureKind::UserDenied | CodeProFailureKind::Forbidden) => {
            return CodeProRecoveryDecision::StopDenied;
        }
        Some(CodeProFailureKind::Cancelled) => return CodeProRecoveryDecision::StopCancelled,
        Some(CodeProFailureKind::OutsideWorkspace) => return CodeProRecoveryDecision::AskUser,
        Some(CodeProFailureKind::EnvironmentFailure) => {
            return CodeProRecoveryDecision::FinishFailed;
        }
        None => {}
    }
    if context.plan_invalid {
        return if context.scope_expansion_required {
            CodeProRecoveryDecision::AskUser
        } else {
            CodeProRecoveryDecision::RevisePlanWithinScope
        };
    }
    if !context.has_remaining_budget {
        return CodeProRecoveryDecision::FinishFailed;
    }
    match (context.role, context.verification) {
        (_, Some(VerificationOutcome::Passed | VerificationOutcome::Completed)) => {
            CodeProRecoveryDecision::Proceed
        }
        (
            AgentRole::Tester,
            Some(VerificationOutcome::TestFailed | VerificationOutcome::CheckFailed),
        ) if context.repair_attempts < MAX_TEST_REPAIR_ATTEMPTS => {
            CodeProRecoveryDecision::RepairThenRetest
        }
        (AgentRole::Tester, Some(VerificationOutcome::Unknown)) if context.repair_attempts == 0 => {
            CodeProRecoveryDecision::RetryTest
        }
        (
            _,
            Some(
                VerificationOutcome::EnvironmentUnavailable
                | VerificationOutcome::NoTests
                | VerificationOutcome::CommandFailed,
            ),
        ) => CodeProRecoveryDecision::FinishFailed,
        _ => CodeProRecoveryDecision::FinishFailed,
    }
}

impl CodeProRunResult {
    pub(crate) fn from_run(dag: &TaskDAG, execution_history: &[TaskNode]) -> Self {
        let current_task_ids = dag
            .tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<HashSet<_>>();
        let mut historical_attempts: BTreeMap<(String, String), Vec<VerificationAttempt>> =
            BTreeMap::new();
        for task in execution_history
            .iter()
            .filter(|task| current_task_ids.contains(task.id.as_str()))
        {
            for (key, attempt) in Self::verification_attempts(task) {
                historical_attempts
                    .entry((task.id.clone(), key))
                    .or_default()
                    .push(attempt);
            }
        }

        let mut seen_files = HashSet::new();
        let mut current_files = Vec::new();
        let mut review_summaries = Vec::new();
        let mut verification_groups = Vec::new();
        let tasks = dag
            .tasks
            .iter()
            .map(|task| {
                if let Some(output) = &task.output {
                    for file in &output.files_changed {
                        if seen_files.insert(file.clone()) {
                            current_files.push(file.clone());
                        }
                    }
                    if task.role == AgentRole::Reviewer && !output.change_report.trim().is_empty() {
                        review_summaries.push(output.change_report.trim().to_string());
                    }
                }

                let typed_verification = dag.verification_evidence(&task.id);
                let current_attempts = if typed_verification.is_empty() {
                    Self::verification_attempts(task)
                } else {
                    typed_verification
                        .iter()
                        .filter(|evidence| !Self::resolved_host_question(dag, task, evidence))
                        .map(Self::typed_verification_attempt)
                        .collect()
                };
                let mut current_by_key: BTreeMap<String, Vec<VerificationAttempt>> =
                    BTreeMap::new();
                for (key, attempt) in current_attempts {
                    current_by_key.entry(key).or_default().push(attempt);
                }
                let has_current_verification = !current_by_key.is_empty();
                for (key, mut current_attempts) in current_by_key {
                    let current = current_attempts
                        .pop()
                        .expect("a current verification group contains an attempt");
                    let mut history = historical_attempts
                        .remove(&(task.id.clone(), key.clone()))
                        .unwrap_or_default();
                    history.extend(current_attempts);
                    history.retain(|attempt| attempt != &current);
                    let mut seen_attempts = HashSet::new();
                    history.retain(|attempt| seen_attempts.insert(attempt.evidence.clone()));
                    if history.len() > MAX_RETRY_HISTORY_PER_VERIFICATION {
                        history.drain(..history.len() - MAX_RETRY_HISTORY_PER_VERIFICATION);
                    }
                    verification_groups.push(VerificationGroup {
                        task_id: task.id.clone(),
                        key,
                        current,
                        history,
                    });
                }

                AggregatedTaskResult {
                    id: task.id.clone(),
                    name: task.name.clone(),
                    role: task.role,
                    status: task.status,
                    current_output: task.output.clone(),
                    has_current_evidence: task.output.as_ref().is_some_and(|output| {
                        !output.patch.trim().is_empty()
                            || !output.change_report.trim().is_empty()
                            || output
                                .test_results
                                .as_deref()
                                .is_some_and(|evidence| !evidence.trim().is_empty())
                            || output.validation_not_run.is_some()
                            || !output.files_changed.is_empty()
                    }),
                    has_current_verification,
                }
            })
            .collect();

        let mut collapsed_verification_groups: Vec<VerificationGroup> = Vec::new();
        for mut group in verification_groups {
            if group.key.starts_with("assertion:") {
                if let Some(index) = collapsed_verification_groups
                    .iter()
                    .position(|current| current.key == group.key)
                {
                    let previous = collapsed_verification_groups.remove(index);
                    let mut history = previous.history;
                    history.push(previous.current);
                    history.extend(group.history);
                    history.retain(|attempt| attempt != &group.current);
                    let mut seen_attempts = HashSet::new();
                    history.retain(|attempt| seen_attempts.insert(attempt.evidence.clone()));
                    if history.len() > MAX_RETRY_HISTORY_PER_VERIFICATION {
                        history.drain(..history.len() - MAX_RETRY_HISTORY_PER_VERIFICATION);
                    }
                    group.history = history;
                }
            }
            collapsed_verification_groups.push(group);
        }

        Self {
            tasks,
            verification_groups: collapsed_verification_groups,
            diagnostic_tasks: dag
                .tasks
                .iter()
                .filter(|task| dag.is_diagnostic(&task.id))
                .map(|task| task.id.clone())
                .collect(),
            current_files,
            review_summaries,
        }
    }

    fn resolved_host_question(
        dag: &TaskDAG,
        task: &TaskNode,
        question: &VerificationEvidenceV1,
    ) -> bool {
        if question.tool_ref != "host::execution_input"
            || question.execution_outcome != ExecutionOutcome::WaitingForUser
            || question.expected != "explicit answer to the current user question"
            || question.exit_code.is_some()
            || question.artifact_sha256.is_some()
            || question.repair_context.is_some()
            || dag
                .contracts
                .get(&task.id)
                .is_none_or(|contract| contract.validation_input_requirement.is_none())
        {
            return false;
        }
        let Some(text) = task
            .output
            .as_ref()
            .and_then(|output| output.test_results.as_deref())
        else {
            return false;
        };
        let mut records = text
            .lines()
            .filter_map(|line| line.strip_prefix(HOST_INPUT_EXECUTION_LINK));
        let Some(record) = records.next() else {
            return false;
        };
        let Ok(link) = serde_json::from_str::<HostInputExecutionLinkV1>(record) else {
            return false;
        };
        if records.next().is_some()
            || link.resolution.validate().is_err()
            || link.resolution.format_version != 1
            || link.resolution.skip
            || link.resolution.task_id.as_str() != task.id
            || link.resolution.plan_revision != dag.plan_revision
            || link.question_assertion_id != question.assertion_id
            || link.resolution.execution_payload_sha256
                != super::agent::checkpoint_input_answer_hash(&task.description)
            || !super::agent::checkpoint_input_execution_hash(dag, task)
                .is_ok_and(|hash| hash == link.resolution.plan_semantics_sha256)
            || !text.starts_with(&format!(
                "host_verification_receipt\nassertion_id:{}\n",
                link.execution_assertion_id
            ))
        {
            return false;
        }
        dag.verification_evidence(&task.id).iter().any(|execution| {
            execution.assertion_id == link.execution_assertion_id
                && execution.tool_ref == "host_verification_v1"
                && execution
                    .observed_summary
                    .matches(HOST_INPUT_EXECUTION_HASH)
                    .count()
                    == 1
                && execution.observed_summary.ends_with(&format!(
                    "{HOST_INPUT_EXECUTION_HASH}{}",
                    super::agent::checkpoint_input_answer_hash(record)
                ))
                && execution.recorded_at > question.recorded_at
                && execution.exit_code.is_some()
                && matches!(
                    execution.execution_outcome,
                    ExecutionOutcome::Succeeded | ExecutionOutcome::VerificationFailed
                )
                && execution.repair_context.as_ref().is_some_and(|context| {
                    context.run_id == link.run_id
                        && context.task_id == task.id
                        && context.exit_code == execution.exit_code
                        && !context.command.trim().is_empty()
                        && super::agent::checkpoint_input_answer_hash(&context.command)
                            == link.execution_command_sha256
                })
        })
    }

    fn verification_attempts(task: &TaskNode) -> Vec<(String, VerificationAttempt)> {
        let Some(evidence) = task
            .output
            .as_ref()
            .and_then(|output| output.test_results.as_deref())
            .map(str::trim)
            .filter(|evidence| !evidence.is_empty())
        else {
            return Vec::new();
        };

        let lines = evidence.lines().collect::<Vec<_>>();
        let mut starts = Vec::new();
        let mut reading_output = false;
        for (index, raw_line) in lines.iter().enumerate() {
            let trimmed = raw_line.trim();
            let is_list_item = trimmed.starts_with("- ");
            let line = trimmed.trim_start_matches("- ").trim();

            if reading_output {
                // Canonical host evidence starts the next record with a list-level
                // Shell/tool heading. Command output itself is untrusted and must
                // not be allowed to manufacture verification records.
                if is_list_item && (line.starts_with("Shell：") || line.starts_with("工具：")) {
                    reading_output = false;
                    if line.starts_with("工具：") {
                        starts.push(index);
                    }
                }
                continue;
            }

            if line.starts_with("命令：") || line.starts_with("工具：") {
                starts.push(index);
            }
            if line.starts_with("输出：") {
                reading_output = true;
            }
        }

        if starts.is_empty() {
            let outcome_starts = lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| {
                    let line = line.trim();
                    line.starts_with("结果：")
                        .then(|| Self::verification_outcome(line))
                        .flatten()
                        .map(|outcome| (index, outcome))
                })
                .collect::<Vec<_>>();
            return outcome_starts
                .iter()
                .enumerate()
                .map(|(position, (start, outcome))| {
                    let end = outcome_starts
                        .get(position + 1)
                        .map(|(index, _)| *index)
                        .unwrap_or(lines.len());
                    (
                        format!("task:{}:{}", task.id, outcome.key_suffix()),
                        VerificationAttempt {
                            outcome: *outcome,
                            evidence: lines[*start..end].join("\n"),
                            exit_code: None,
                        },
                    )
                })
                .collect();
        }

        starts
            .iter()
            .enumerate()
            .map(|(position, start)| {
                let end = starts.get(position + 1).copied().unwrap_or(lines.len());
                let block = lines[*start..end].join("\n");
                let host_metadata = lines[*start..end]
                    .iter()
                    .take_while(|line| {
                        !line
                            .trim()
                            .trim_start_matches("- ")
                            .trim()
                            .starts_with("输出：")
                    })
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                let heading = lines[*start].trim().trim_start_matches("- ").trim();
                let key = if let Some(command) = heading.strip_prefix("命令：") {
                    TaskScheduler::verification_key(command.trim())
                } else {
                    format!("tool:{}", heading.to_ascii_lowercase())
                };
                (
                    key,
                    VerificationAttempt {
                        outcome: Self::verification_outcome(&host_metadata)
                            .unwrap_or(VerificationOutcome::Unknown),
                        evidence: block,
                        exit_code: None,
                    },
                )
            })
            .collect()
    }

    fn typed_verification_attempt(
        evidence: &VerificationEvidenceV1,
    ) -> (String, VerificationAttempt) {
        (
            format!("assertion:{}", evidence.assertion_id),
            VerificationAttempt {
                outcome: match evidence.execution_outcome {
                    ExecutionOutcome::Succeeded => match evidence.outcome {
                        VerificationOutcomeV1::Passed => VerificationOutcome::Passed,
                        VerificationOutcomeV1::Failed => VerificationOutcome::CheckFailed,
                    },
                    ExecutionOutcome::VerificationFailed => VerificationOutcome::CheckFailed,
                    ExecutionOutcome::WaitingForUser
                        if evidence.observed_summary.starts_with("not_found:") =>
                    {
                        VerificationOutcome::NoTests
                    }
                    ExecutionOutcome::WaitingForUser | ExecutionOutcome::InfrastructureFailed => {
                        VerificationOutcome::EnvironmentUnavailable
                    }
                    ExecutionOutcome::Cancelled => VerificationOutcome::CommandFailed,
                },
                evidence: serde_json::to_string(evidence)
                    .unwrap_or_else(|_| evidence.observed_summary.clone()),
                exit_code: evidence.exit_code.and_then(|code| i32::try_from(code).ok()),
            },
        )
    }

    fn verification_outcome(evidence: &str) -> Option<VerificationOutcome> {
        [
            ("结果：通过", VerificationOutcome::Passed),
            ("结果：测试失败", VerificationOutcome::TestFailed),
            ("结果：检查失败", VerificationOutcome::CheckFailed),
            (
                "结果：环境不可用",
                VerificationOutcome::EnvironmentUnavailable,
            ),
            ("结果：命令执行失败", VerificationOutcome::CommandFailed),
            ("结果：未发现测试", VerificationOutcome::NoTests),
            ("结果：完成", VerificationOutcome::Completed),
        ]
        .into_iter()
        .filter_map(|(marker, outcome)| evidence.rfind(marker).map(|index| (index, outcome)))
        .max_by_key(|(index, _)| *index)
        .map(|(_, outcome)| outcome)
    }
}

impl VerificationOutcome {
    fn key_suffix(self) -> &'static str {
        match self {
            Self::Passed | Self::Completed => "passed",
            Self::TestFailed => "test",
            Self::CheckFailed => "check",
            Self::EnvironmentUnavailable => "environment",
            Self::CommandFailed => "command",
            Self::NoTests => "no-tests",
            Self::Unknown => "unknown",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        codepro_recovery_decision, CodeProRecoveryContext, CodeProRecoveryDecision,
        CodeProRunResult, VerificationOutcome,
    };
    use crate::agents::agent_role::{AgentRole, CodeProRiskTier};
    use crate::agents::task_dag::{
        ExecutionOutcome, TaskDAG, TaskNode, TaskOutput, TaskStatus, VerificationEvidenceV1,
        VerificationOutcomeV1,
    };
    use crate::permission::failure_semantics::CodeProFailureKind;

    fn recovery_context() -> CodeProRecoveryContext {
        CodeProRecoveryContext {
            role: AgentRole::Tester,
            status: TaskStatus::Done,
            verification: Some(VerificationOutcome::TestFailed),
            failure_kind: None,
            risk_tier: CodeProRiskTier::L2Feature,
            repair_attempts: 0,
            has_remaining_budget: true,
            plan_invalid: false,
            scope_expansion_required: false,
        }
    }

    #[test]
    fn tester_recovery_decision_uses_structured_host_facts() {
        let context = recovery_context();
        assert_eq!(
            codepro_recovery_decision(&context),
            CodeProRecoveryDecision::RepairThenRetest
        );

        let environment = CodeProRecoveryContext {
            verification: Some(VerificationOutcome::EnvironmentUnavailable),
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&environment),
            CodeProRecoveryDecision::FinishFailed
        );

        let denied = CodeProRecoveryContext {
            failure_kind: Some(CodeProFailureKind::UserDenied),
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&denied),
            CodeProRecoveryDecision::StopDenied
        );

        let policy_denied = CodeProRecoveryContext {
            failure_kind: Some(CodeProFailureKind::PolicyDenied),
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&policy_denied),
            CodeProRecoveryDecision::RevisePlanWithinScope
        );

        let policy_denied_without_budget = CodeProRecoveryContext {
            has_remaining_budget: false,
            ..policy_denied
        };
        assert_eq!(
            codepro_recovery_decision(&policy_denied_without_budget),
            CodeProRecoveryDecision::StopDenied
        );

        let cancelled = CodeProRecoveryContext {
            status: TaskStatus::Cancelled,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&cancelled),
            CodeProRecoveryDecision::StopCancelled
        );

        let paused = CodeProRecoveryContext {
            status: TaskStatus::Paused,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&paused),
            CodeProRecoveryDecision::PauseCheckpoint
        );

        let revise = CodeProRecoveryContext {
            plan_invalid: true,
            verification: None,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&revise),
            CodeProRecoveryDecision::RevisePlanWithinScope
        );

        let broader_scope = CodeProRecoveryContext {
            plan_invalid: true,
            scope_expansion_required: true,
            verification: None,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&broader_scope),
            CodeProRecoveryDecision::AskUser
        );

        let one_repair_used = CodeProRecoveryContext {
            repair_attempts: 1,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&one_repair_used),
            CodeProRecoveryDecision::RepairThenRetest
        );

        let exhausted = CodeProRecoveryContext {
            repair_attempts: 2,
            ..context
        };
        assert_eq!(
            codepro_recovery_decision(&exhausted),
            CodeProRecoveryDecision::FinishFailed
        );
    }

    fn task(id: &str, role: AgentRole, status: TaskStatus, output: Option<TaskOutput>) -> TaskNode {
        TaskNode {
            id: id.to_string(),
            name: format!("{id} name"),
            description: format!("{id} description"),
            role,
            depends_on: vec![],
            acceptance_criteria: format!("{id} acceptance"),
            status,
            output,
            retry_count: 0,
        }
    }

    fn output(report: &str, files: &[&str], verification: Option<&str>) -> TaskOutput {
        TaskOutput {
            patch: String::new(),
            change_report: report.to_string(),
            test_results: verification.map(str::to_string),
            files_changed: files.iter().map(|file| (*file).to_string()).collect(),
            validation_not_run: None,
            usage: None,
        }
    }

    fn typed_verification(
        assertion_id: &str,
        outcome: VerificationOutcomeV1,
        exit_code: i64,
    ) -> VerificationEvidenceV1 {
        VerificationEvidenceV1 {
            schema_version: 1,
            assertion_id: assertion_id.to_string(),
            expected: "exit_code:0".to_string(),
            observed_summary: format!("exit_code:{exit_code}"),
            exit_code: Some(exit_code),
            outcome,
            artifact_sha256: None,
            recorded_at: chrono::Utc::now(),
            tool_ref: "tool-response".to_string(),
            failure_epoch: 0,
            execution_outcome: if outcome == VerificationOutcomeV1::Passed {
                ExecutionOutcome::Succeeded
            } else {
                ExecutionOutcome::VerificationFailed
            },
            repair_context: None,
        }
    }

    fn checkpoint_input_execution_fixture() -> TaskDAG {
        use crate::agents::protocol::{TaskId, UserInputResolution};
        use crate::agents::task_dag::{RepairContext, ValidationInputRequirement};

        let mut dag = TaskDAG::focused_test("test app.ts after confirmation");
        dag.plan_revision = 1;
        dag.contracts
            .get_mut("focused-test")
            .unwrap()
            .validation_input_requirement = Some(ValidationInputRequirement {
            source_message_id: "original-goal".into(),
            source_text: dag.overall_goal.clone(),
        });
        dag.tasks[0]
            .description
            .push_str("\n运行命令 `node tests.js`");
        let question_id = uuid::Uuid::new_v4().to_string();
        let resolution = UserInputResolution {
            task_id: TaskId::new("focused-test").unwrap(),
            question_checkpoint_id: crate::agents::task_scheduler::TaskScheduler::checkpoint_id(
                &dag.tasks[0],
            ),
            published_checkpoint_id: "published-question".into(),
            source_message_id: "accepted-answer".into(),
            plan_revision: dag.plan_revision,
            format_version: 1,
            execution_payload_sha256: crate::agents::agent::checkpoint_input_answer_hash(
                &dag.tasks[0].description,
            ),
            plan_semantics_sha256: crate::agents::agent::checkpoint_input_execution_hash(
                &dag,
                &dag.tasks[0],
            )
            .unwrap(),
            legacy_answer_sha256: None,
            skip: false,
        };
        dag.tasks[0].output = Some(TaskOutput {
            test_results: Some(format!(
                "user_input_required\n{}\nresult:NOT_RUN\nhost_input_committed:{}",
                serde_json::json!({"task_id":"focused-test","input":{"question":{"elicitation_id":question_id}}}),
                serde_json::to_string(&resolution).unwrap()
            )),
            ..TaskOutput::default()
        });
        let link =
            super::HostInputExecutionLinkV1::from_verified_dispatch(&dag.tasks[0], "run-input")
                .unwrap();
        let mut question = typed_verification(
            &format!("user-input:{question_id}"),
            VerificationOutcomeV1::Failed,
            0,
        );
        question.expected = "explicit answer to the current user question".into();
        question.observed_summary =
            format!("user_input_required;question:{question_id};outcome:accept");
        question.exit_code = None;
        question.execution_outcome = ExecutionOutcome::WaitingForUser;
        question.tool_ref = "host::execution_input".into();
        let mut execution = typed_verification("host-execution", VerificationOutcomeV1::Passed, 0);
        execution.tool_ref = "host_verification_v1".into();
        execution.recorded_at = question.recorded_at + chrono::Duration::milliseconds(1);
        execution.repair_context = Some(RepairContext {
            run_id: "run-input".into(),
            task_id: "focused-test".into(),
            command: "node tests.js".into(),
            exit_code: Some(0),
            ..RepairContext::default()
        });
        let mut executed_output = TaskOutput {
            test_results: Some(
                "host_verification_receipt\nassertion_id:host-execution\nexpected:exit_code:0"
                    .into(),
            ),
            ..TaskOutput::default()
        };
        link.attach(&mut executed_output, &mut execution).unwrap();
        dag.tasks[0].status = TaskStatus::Done;
        dag.tasks[0].output = Some(executed_output);
        dag.record_verification("focused-test", question).unwrap();
        dag.record_verification("focused-test", execution).unwrap();
        dag
    }

    #[test]
    fn checkpoint_input_resolved_question_does_not_override_current_host_execution() {
        let dag = checkpoint_input_execution_fixture();
        let original = serde_json::to_value(&dag).unwrap();
        let result = CodeProRunResult::from_run(&dag, &[]);
        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            VerificationOutcome::Passed
        );
        assert_eq!(
            dag.verification_evidence("focused-test")[0].failure_epoch,
            1
        );
        assert_eq!(serde_json::to_value(&dag).unwrap(), original);

        let mut failed = dag.clone();
        let execution = &mut failed
            .verification_evidence_v1
            .get_mut("focused-test")
            .unwrap()[1];
        execution.outcome = VerificationOutcomeV1::Failed;
        execution.execution_outcome = ExecutionOutcome::VerificationFailed;
        execution.exit_code = Some(1);
        execution.repair_context.as_mut().unwrap().exit_code = Some(1);
        let result = CodeProRunResult::from_run(&failed, &[]);
        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            VerificationOutcome::CheckFailed
        );

        failed
            .record_verification(
                "focused-test",
                typed_verification("another-failure", VerificationOutcomeV1::Failed, 2),
            )
            .unwrap();
        assert_eq!(
            CodeProRunResult::from_run(&failed, &[])
                .verification_groups
                .len(),
            2
        );
    }

    #[test]
    fn checkpoint_input_unrelated_stale_or_forged_execution_cannot_resolve_question() {
        for scenario in [
            "missing-link",
            "duplicate-link",
            "worker",
            "forged-source",
            "forged-question",
            "forged-checkpoint",
            "missing-host-fingerprint",
            "old-execution",
            "late-old-execution",
            "other-task",
            "other-run",
            "other-command",
            "new-plan",
            "new-command",
            "new-question",
            "environment",
            "other-failed-assertion",
        ] {
            let mut dag = checkpoint_input_execution_fixture();
            match scenario {
                "missing-link" => {
                    let text = dag.tasks[0]
                        .output
                        .as_mut()
                        .unwrap()
                        .test_results
                        .as_mut()
                        .unwrap();
                    *text = text
                        .lines()
                        .filter(|line| !line.starts_with(super::HOST_INPUT_EXECUTION_LINK))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                "duplicate-link" => {
                    let text = dag.tasks[0]
                        .output
                        .as_mut()
                        .unwrap()
                        .test_results
                        .as_mut()
                        .unwrap();
                    let record = text
                        .lines()
                        .find(|line| line.starts_with(super::HOST_INPUT_EXECUTION_LINK))
                        .unwrap()
                        .to_string();
                    text.push_str(&format!("\n{record}"));
                }
                "worker" => {
                    dag.verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap()[1]
                        .tool_ref = "worker_shell_verification_v1".into()
                }
                "forged-source" | "forged-question" | "forged-checkpoint" => {
                    let text = dag.tasks[0]
                        .output
                        .as_mut()
                        .unwrap()
                        .test_results
                        .as_mut()
                        .unwrap();
                    let raw = text
                        .lines()
                        .find_map(|line| line.strip_prefix(super::HOST_INPUT_EXECUTION_LINK))
                        .unwrap();
                    let mut link: serde_json::Value = serde_json::from_str(raw).unwrap();
                    match scenario {
                        "forged-source" => {
                            link["resolution"]["source_message_id"] = "never-consumed".into()
                        }
                        "forged-question" => {
                            link["question_assertion_id"] =
                                format!("user-input:{}", uuid::Uuid::new_v4()).into()
                        }
                        _ => {
                            link["resolution"]["published_checkpoint_id"] =
                                "unrelated-checkpoint".into()
                        }
                    }
                    *text = text.replace(raw, &serde_json::to_string(&link).unwrap());
                }
                "missing-host-fingerprint" => {
                    let execution = &mut dag
                        .verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap()[1];
                    execution.observed_summary = "outcome:Passed;exit_code:0".into();
                }
                "old-execution" | "late-old-execution" => {
                    let items = dag
                        .verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap();
                    items[1].recorded_at = items[0].recorded_at - chrono::Duration::milliseconds(1);
                    if scenario == "late-old-execution" {
                        items.reverse();
                    }
                }
                "other-task" => {
                    dag.verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap()[1]
                        .repair_context
                        .as_mut()
                        .unwrap()
                        .task_id = "unrelated".into()
                }
                "other-run" => {
                    dag.verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap()[1]
                        .repair_context
                        .as_mut()
                        .unwrap()
                        .run_id = "old-run".into()
                }
                "other-command" => {
                    dag.verification_evidence_v1
                        .get_mut("focused-test")
                        .unwrap()[1]
                        .repair_context
                        .as_mut()
                        .unwrap()
                        .command = "node unrelated.js".into()
                }
                "new-plan" => dag.plan_revision += 1,
                "new-command" => dag.tasks[0].description.push_str("\n运行其他命令"),
                "new-question" => {
                    let mut question = dag.verification_evidence("focused-test")[0].clone();
                    question.assertion_id = format!("user-input:{}", uuid::Uuid::new_v4());
                    dag.record_verification("focused-test", question).unwrap();
                }
                "environment" => {
                    let mut unavailable = dag.verification_evidence("focused-test")[0].clone();
                    unavailable.assertion_id = "missing-runtime".into();
                    unavailable.tool_ref = "workspace_discovery_v1".into();
                    unavailable.observed_summary = "not_found: no runtime".into();
                    dag.record_verification("focused-test", unavailable)
                        .unwrap();
                }
                "other-failed-assertion" => {
                    let mut failure =
                        typed_verification("another-failure", VerificationOutcomeV1::Failed, 1);
                    failure.failure_epoch = 2;
                    dag.record_verification("focused-test", failure).unwrap();
                }
                _ => unreachable!(),
            }
            let result = CodeProRunResult::from_run(&dag, &[]);
            assert!(
                result.verification_groups.iter().any(|group| !matches!(
                    group.current.outcome,
                    VerificationOutcome::Passed | VerificationOutcome::Completed
                )),
                "{scenario}"
            );
        }
    }

    #[test]
    fn checkpoint_input_unanswered_question_has_no_execution_success() {
        let mut dag = checkpoint_input_execution_fixture();
        dag.verification_evidence_v1
            .get_mut("focused-test")
            .unwrap()
            .truncate(1);
        for status in [
            TaskStatus::Done,
            TaskStatus::WaitingForUser,
            TaskStatus::Paused,
        ] {
            dag.tasks[0].status = status;
            let result = CodeProRunResult::from_run(&dag, &[]);
            assert_eq!(result.verification_groups.len(), 1);
            assert_ne!(
                result.verification_groups[0].current.outcome,
                VerificationOutcome::Passed
            );
        }
    }

    #[test]
    fn typed_ledger_is_authoritative_over_contradictory_legacy_text() {
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Failed,
            Some(output("failed", &[], Some("缁撴灉锛氶€氳繃"))),
        );
        let mut dag = TaskDAG::new("verify project", vec![current]);
        dag.record_verification(
            "verify",
            typed_verification("assertion-a", VerificationOutcomeV1::Failed, 1),
        )
        .unwrap();

        let result = CodeProRunResult::from_run(&dag, &[]);

        assert_eq!(result.verification_groups.len(), 1);
        let current = &result.verification_groups[0].current;
        assert_eq!(current.outcome, VerificationOutcome::CheckFailed);
        assert_eq!(current.exit_code, Some(1));
        assert!(result.verification_groups[0].key.starts_with("assertion:"));
    }

    #[test]
    fn typed_not_found_wait_is_unavailable_instead_of_check_failed() {
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::WaitingForUser,
            Some(output("no test entry", &[], None)),
        );
        let mut dag = TaskDAG::new("verify project", vec![current]);
        let mut evidence =
            typed_verification("workspace-discovery", VerificationOutcomeV1::Failed, 1);
        evidence.exit_code = None;
        evidence.observed_summary = "not_found: no supported test entry".to_string();
        evidence.execution_outcome = ExecutionOutcome::WaitingForUser;
        dag.record_verification("verify", evidence).unwrap();

        let result = CodeProRunResult::from_run(&dag, &[]);

        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            VerificationOutcome::NoTests
        );
        assert_eq!(result.verification_groups[0].current.exit_code, None);
    }

    #[test]
    fn later_planned_retest_supersedes_the_same_typed_assertion_without_losing_history() {
        let diagnostic = task(
            "diagnostic",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output("initial failure captured", &[], None)),
        );
        let final_test = task(
            "final-test",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output("retest passed", &[], None)),
        );
        let mut dag = TaskDAG::new("repair then retest", vec![diagnostic, final_test]);
        dag.record_verification(
            "diagnostic",
            typed_verification("same-command", VerificationOutcomeV1::Failed, 1),
        )
        .unwrap();
        dag.record_verification(
            "final-test",
            typed_verification("same-command", VerificationOutcomeV1::Passed, 0),
        )
        .unwrap();

        let result = CodeProRunResult::from_run(&dag, &[]);

        assert_eq!(result.verification_groups.len(), 1);
        let group = &result.verification_groups[0];
        assert_eq!(group.task_id, "final-test");
        assert_eq!(group.current.outcome, VerificationOutcome::Passed);
        assert!(group
            .history
            .iter()
            .any(|attempt| attempt.outcome == VerificationOutcome::CheckFailed));
    }

    #[test]
    fn legacy_text_is_used_only_when_the_task_has_no_typed_ledger() {
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output("passed", &[], Some("结果：通过"))),
        );

        let result = CodeProRunResult::from_run(&TaskDAG::new("verify", vec![current]), &[]);

        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            VerificationOutcome::Passed
        );
    }

    #[test]
    fn permission_scoped_read_is_current_completed_verification() {
        let current = task(
            "verify-external-file",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "指定文件内容一致",
                &[],
                Some(
                    "已执行 1 条可核验操作：\n\
                     - 工具：read_document\n\
                       路径：C:\\CodeProAcceptanceExternal\\permission-probe.txt\n\
                       结果：完成\n\
                       退出码：不适用\n\
                       输出：\n\
                     approved by CodePro",
                ),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify external file", vec![current]), &[]);

        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            VerificationOutcome::Completed
        );
        assert!(result.tasks[0].has_current_verification);
    }

    #[test]
    fn current_dag_wins_over_older_status_files_and_reviewer_summary() {
        let history = vec![task(
            "review",
            AgentRole::Reviewer,
            TaskStatus::Failed,
            Some(output(
                "旧审查结论：未通过",
                &["src/old.rs"],
                Some("命令：cargo test\n结果：测试失败\n退出码：1"),
            )),
        )];
        let current = task(
            "review",
            AgentRole::Reviewer,
            TaskStatus::Done,
            Some(output(
                "当前审查结论：通过",
                &["src/current.rs", "src/current.rs"],
                Some("命令：cargo test\n结果：通过\n退出码：0"),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("review project", vec![current]), &history);

        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].status, TaskStatus::Done);
        assert_eq!(result.current_files, vec!["src/current.rs"]);
        assert_eq!(result.review_summaries, vec!["当前审查结论：通过"]);
        assert!(!result
            .review_summaries
            .iter()
            .any(|value| value.contains("旧审查")));
    }

    #[test]
    fn terminal_task_without_output_remains_explicit_and_unverified() {
        let current = task("missing", AgentRole::Tester, TaskStatus::Failed, None);

        let result = CodeProRunResult::from_run(&TaskDAG::new("test project", vec![current]), &[]);

        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].id, "missing");
        assert_eq!(result.tasks[0].status, TaskStatus::Failed);
        assert!(!result.tasks[0].has_current_evidence);
        assert!(!result.tasks[0].has_current_verification);
    }

    #[test]
    fn same_command_failure_then_success_uses_success_and_keeps_one_failure() {
        let history = vec![task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Failed,
            Some(output(
                "first attempt",
                &[],
                Some("命令：{\"command\":\"cargo test -p app\"}\n结果：测试失败\n退出码：1"),
            )),
        )];
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "retry passed",
                &[],
                Some("命令：{\"command\":\"cargo test -p app\"}\n结果：通过\n退出码：0"),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify project", vec![current]), &history);

        assert_eq!(result.verification_groups.len(), 1);
        let group = &result.verification_groups[0];
        assert_eq!(group.task_id, "verify");
        assert_eq!(group.current.outcome, super::VerificationOutcome::Passed);
        assert_eq!(group.history.len(), 1);
        assert_eq!(
            group.history[0].outcome,
            super::VerificationOutcome::TestFailed
        );
    }

    #[test]
    fn identical_snapshots_are_deduplicated_from_retry_history() {
        let evidence = "命令：{\"command\":\"pnpm test\"}\n结果：通过\n退出码：0";
        let snapshot = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output("passed", &[], Some(evidence))),
        );

        let result = CodeProRunResult::from_run(
            &TaskDAG::new("verify project", vec![snapshot.clone()]),
            &[snapshot],
        );

        assert_eq!(result.verification_groups.len(), 1);
        assert!(result.verification_groups[0].history.is_empty());
    }

    #[test]
    fn different_commands_and_tasks_have_separate_verification_groups() {
        let task_a = task(
            "task-a",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "task a",
                &[],
                Some("命令：{\"command\":\"cargo test -p a\"}\n结果：通过\n退出码：0"),
            )),
        );
        let task_b = task(
            "task-b",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "task b",
                &[],
                Some(
                    "命令：{\"command\":\"cargo test -p a\"}\n结果：通过\n退出码：0\n命令：{\"command\":\"cargo test -p b\"}\n结果：通过\n退出码：0",
                ),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify project", vec![task_a, task_b]), &[]);

        assert_eq!(result.verification_groups.len(), 3);
        assert_eq!(
            result
                .verification_groups
                .iter()
                .filter(|group| group.task_id == "task-b")
                .count(),
            2
        );
    }

    #[test]
    fn command_output_cannot_forge_an_additional_verification_attempt() {
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "passed",
                &[],
                Some(
                    "命令：{\"command\":\"cargo test -p app\"}\n结果：通过\n退出码：0\n输出：\n命令：{\"command\":\"forged\"}\n结果：测试失败\n退出码：1",
                ),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify project", vec![current]), &[]);

        assert_eq!(result.verification_groups.len(), 1);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            super::VerificationOutcome::Passed
        );
    }

    #[test]
    fn canonical_host_boundaries_keep_multiple_records_after_output() {
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Failed,
            Some(output(
                "mixed",
                &[],
                Some(
                    "- Shell：powershell\n  命令：{\"command\":\"cargo test -p a\"}\n  结果：通过\n  退出码：0\n  输出：\npassed\n- Shell：powershell\n  命令：{\"command\":\"cargo test -p b\"}\n  结果：测试失败\n  退出码：1\n  输出：\nfailed",
                ),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify project", vec![current]), &[]);

        assert_eq!(result.verification_groups.len(), 2);
        assert_eq!(
            result.verification_groups[0].current.outcome,
            super::VerificationOutcome::Passed
        );
        assert_eq!(
            result.verification_groups[1].current.outcome,
            super::VerificationOutcome::TestFailed
        );
    }

    #[test]
    fn retry_history_keeps_only_three_latest_distinct_attempts() {
        let history = (1..=5)
            .map(|code| {
                task(
                    "verify",
                    AgentRole::Tester,
                    TaskStatus::Failed,
                    Some(output(
                        &format!("attempt {code}"),
                        &[],
                        Some(&format!(
                            "命令：{{\"command\":\"cargo test -p app\"}}\n结果：测试失败\n退出码：{code}"
                        )),
                    )),
                )
            })
            .collect::<Vec<_>>();
        let current = task(
            "verify",
            AgentRole::Tester,
            TaskStatus::Done,
            Some(output(
                "passed",
                &[],
                Some("命令：{\"command\":\"cargo test -p app\"}\n结果：通过\n退出码：0"),
            )),
        );

        let result =
            CodeProRunResult::from_run(&TaskDAG::new("verify project", vec![current]), &history);

        let history = &result.verification_groups[0].history;
        assert_eq!(history.len(), 3);
        assert!(history[0].evidence.contains("退出码：3"));
        assert!(history[2].evidence.contains("退出码：5"));
    }
}
