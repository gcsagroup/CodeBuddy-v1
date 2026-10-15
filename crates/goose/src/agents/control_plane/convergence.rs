use crate::agents::protocol::{EvidenceRef, ProtocolError, RunId, RunState, TaskId, TaskState};
use crate::agents::reporting::RunProjection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const ROOT_USER_REQUIREMENT_ID: &str = "run-goal";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequirementEvidenceCoverage {
    pub requirement_id: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    #[serde(default)]
    pub audit_ids: Vec<String>,
    #[serde(default)]
    pub resource_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionObligationEvidenceCoverage {
    pub obligation_id: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    pub audit_id: String,
    pub invocation: crate::agents::validation_invocation::ValidationInvocation,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvergenceStatus {
    InProgress,
    Blocked,
    Eligible,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CompletionProposal {
    pub plan_revision: Option<u32>,
    pub requirement_revision: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_task_id: Option<TaskId>,
    #[serde(default)]
    pub requirement_coverage: Vec<RequirementEvidenceCoverage>,
    #[serde(default)]
    pub execution_obligation_coverage: Vec<ExecutionObligationEvidenceCoverage>,
    pub reviewer_blockers: Vec<String>,
    pub unresolved_high_risk_writes: Vec<String>,
    pub uncertain_effects: Vec<String>,
    pub unverified_requirements: Vec<String>,
}

impl CompletionProposal {
    pub fn for_projection(projection: &RunProjection) -> Self {
        Self {
            plan_revision: Some(projection.plan_revision),
            requirement_revision: Some(projection.user_requirement_revision),
            ..Self::default()
        }
    }

    pub fn for_main_agent(
        projection: &RunProjection,
        task_id: TaskId,
        _evidence_refs: Vec<EvidenceRef>,
    ) -> Self {
        Self {
            plan_revision: Some(projection.plan_revision),
            requirement_revision: Some(projection.user_requirement_revision),
            completion_task_id: Some(task_id),
            ..Self::default()
        }
    }

    /// Coverage is a model proposal checked against host facts; possessing an
    /// evidence bundle never assigns that bundle to every user requirement.
    pub fn for_main_agent_with_coverage(
        projection: &RunProjection,
        task_id: TaskId,
        requirement_coverage: Vec<RequirementEvidenceCoverage>,
        execution_obligation_coverage: Vec<ExecutionObligationEvidenceCoverage>,
    ) -> Self {
        Self {
            requirement_coverage,
            execution_obligation_coverage,
            ..Self::for_main_agent(projection, task_id, Vec::new())
        }
    }

    pub fn for_main_agent_with_obligations(
        projection: &RunProjection,
        task_id: TaskId,
        evidence_refs: Vec<EvidenceRef>,
        execution_obligation_coverage: Vec<ExecutionObligationEvidenceCoverage>,
    ) -> Self {
        let mut proposal = Self::for_main_agent(projection, task_id, evidence_refs);
        proposal.execution_obligation_coverage = execution_obligation_coverage;
        proposal
    }

    pub(crate) fn for_dag(
        projection: &RunProjection,
        dag: &crate::agents::task_dag::TaskDAG,
        reviewer_approved: bool,
    ) -> Self {
        let mut proposal = Self::for_projection(projection);
        proposal.unverified_requirements = dag.unmet_goal_requirements();
        for task in dag.tasks.iter().filter(|task| {
            task.role == crate::agents::AgentRole::Tester
                && !dag.is_diagnostic(&task.id)
                && task.status != crate::agents::task_dag::TaskStatus::Skipped
        }) {
            let evidence = dag.verification_evidence(&task.id);
            if evidence.is_empty()
                || evidence.iter().any(|item| {
                    item.outcome != crate::agents::task_dag::VerificationOutcomeV1::Passed
                        || item.execution_outcome
                            != crate::agents::task_dag::ExecutionOutcome::Succeeded
                })
            {
                proposal
                    .unverified_requirements
                    .push(format!("typed_verification_not_passed:{}", task.id));
            }
        }
        if dag.overall_goal != projection.goal {
            proposal
                .unverified_requirements
                .push("goal_binding_mismatch".to_string());
        }
        if dag
            .risk_assessment
            .as_ref()
            .is_some_and(|risk| risk.review_required())
            && !reviewer_approved
        {
            proposal
                .reviewer_blockers
                .push("review_not_approved".to_string());
        }
        proposal
    }

    pub(crate) fn extend_uncertain_effects(&mut self, effects: impl IntoIterator<Item = String>) {
        self.uncertain_effects.extend(effects);
        self.uncertain_effects.sort_unstable();
        self.uncertain_effects.dedup();
    }

    pub(crate) fn unverified_requirements(&self) -> &[String] {
        &self.unverified_requirements
    }

    pub fn validate_for_run(&self, run_id: &RunId) -> Result<(), ProtocolError> {
        if self.completion_task_id.is_none() && !self.requirement_coverage.is_empty() {
            return Err(ProtocolError::InvalidEnvelope(
                "requirement coverage requires a completion task".to_string(),
            ));
        }
        let mut requirement_ids = BTreeSet::new();
        for coverage in &self.requirement_coverage {
            let requirement_id = coverage.requirement_id.trim();
            if requirement_id.is_empty() {
                return Err(ProtocolError::InvalidEnvelope(
                    "requirement coverage id must not be empty".to_string(),
                ));
            }
            if !requirement_ids.insert(requirement_id) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "duplicate requirement coverage: {requirement_id}"
                )));
            }
            for evidence in &coverage.evidence_refs {
                evidence.validate_for_run(run_id)?;
            }
            if coverage.audit_ids.iter().any(|id| id.trim().is_empty())
                || coverage
                    .resource_versions
                    .iter()
                    .any(|(resource, version)| {
                        resource.trim().is_empty() || version.trim().is_empty()
                    })
            {
                return Err(ProtocolError::InvalidEnvelope(
                    "requirement coverage contains an empty action or resource version".to_string(),
                ));
            }
        }
        let mut obligation_ids = BTreeSet::new();
        for coverage in &self.execution_obligation_coverage {
            let obligation_id = coverage.obligation_id.trim();
            if obligation_id.is_empty() || coverage.audit_id.trim().is_empty() {
                return Err(ProtocolError::InvalidEnvelope(
                    "execution obligation coverage requires ids".to_string(),
                ));
            }
            if !obligation_ids.insert(obligation_id) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "duplicate execution obligation coverage: {obligation_id}"
                )));
            }
            for evidence in &coverage.evidence_refs {
                evidence.validate_for_run(run_id)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CompletionRequirements {
    pub plan_revision: Option<u32>,
    pub requirement_revision: Option<u32>,
    pub completion_task_id: Option<TaskId>,
    pub requirement_coverage: BTreeMap<String, Vec<EvidenceRef>>,
    pub requirement_claims: Vec<RequirementEvidenceCoverage>,
    pub execution_obligation_coverage: BTreeMap<String, ExecutionObligationEvidenceCoverage>,
    pub goal_evidence: Vec<EvidenceRef>,
    pub evidence_required_tasks: BTreeSet<TaskId>,
    pub reviewer_blockers: Vec<String>,
    pub unresolved_high_risk_writes: Vec<String>,
    pub uncertain_effects: Vec<String>,
    pub unverified_requirements: Vec<String>,
}

impl CompletionRequirements {
    pub fn host_derived(projection: &RunProjection, proposal: &CompletionProposal) -> Self {
        let task_ids: BTreeSet<TaskId> = projection
            .current_task_graph()
            .map(|graph| graph.task_ids().cloned().collect())
            .unwrap_or_default();
        let requirement_coverage = proposal
            .requirement_coverage
            .iter()
            .map(|coverage| {
                (
                    coverage.requirement_id.clone(),
                    coverage.evidence_refs.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let execution_obligation_coverage = proposal
            .execution_obligation_coverage
            .iter()
            .cloned()
            .map(|coverage| (coverage.obligation_id.clone(), coverage))
            .collect::<BTreeMap<_, _>>();
        let mut goal_evidence = requirement_coverage
            .values()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        for evidence in projection
            .tasks
            .iter()
            .filter(|(task_id, _)| task_ids.contains(*task_id))
            .filter_map(|(_, task)| task.result.as_ref())
            .flat_map(|result| result.evidence_refs.iter())
        {
            if !goal_evidence.contains(evidence) {
                goal_evidence.push(evidence.clone());
            }
        }
        let evidence_required_tasks = task_ids;
        Self {
            plan_revision: proposal.plan_revision,
            requirement_revision: proposal.requirement_revision,
            completion_task_id: proposal.completion_task_id.clone(),
            requirement_coverage,
            requirement_claims: proposal.requirement_coverage.clone(),
            execution_obligation_coverage,
            goal_evidence,
            evidence_required_tasks,
            reviewer_blockers: proposal.reviewer_blockers.clone(),
            unresolved_high_risk_writes: proposal.unresolved_high_risk_writes.clone(),
            uncertain_effects: proposal.uncertain_effects.clone(),
            unverified_requirements: proposal.unverified_requirements.clone(),
        }
    }

    pub(crate) fn goal_evidence(&self) -> &[EvidenceRef] {
        &self.goal_evidence
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvergenceBlocker {
    MissingTopology,
    RunNotConvergent(RunState),
    TaskNotSuccessful {
        task_id: TaskId,
        state: TaskState,
    },
    MissingGoalEvidence,
    CrossRunGoalEvidence,
    UncommittedGoalEvidence,
    EvidenceCoverageMismatch,
    MissingTaskEvidence(TaskId),
    UnknownEvidenceRequirement(TaskId),
    ReviewerBlockers(usize),
    UnresolvedHighRiskWrites(usize),
    UncertainEffects(Vec<String>),
    StalePlanRevision,
    StaleRequirementRevision,
    UnknownRequirementSemantics(String),
    UnknownRequirementEffect(String),
    UnverifiedRequirements(Vec<String>),
    RequirementCoverageMismatch,
    MissingRequirementEvidence(String),
    MissingRequirementActionEvidence(String),
    RequirementEvidenceNotCommitted {
        requirement_id: String,
        task_id: TaskId,
    },
    ExecutionObligationCoverageMismatch,
    MissingExecutionObligationEvidence(String),
    ExecutionObligationNotSatisfied(String),
    ExecutionObligationEvidenceNotCommitted {
        obligation_id: String,
        task_id: TaskId,
    },
}

impl ConvergenceBlocker {
    pub fn main_agent_gap(&self) -> String {
        match self {
            Self::MissingTopology => "authoritative task topology is unavailable".to_string(),
            Self::RunNotConvergent(state) => {
                format!("run state {state:?} cannot be completed")
            }
            Self::TaskNotSuccessful { task_id, state } => {
                format!("task {task_id} is still {state:?}")
            }
            Self::MissingGoalEvidence => "no committed goal evidence is available".to_string(),
            Self::CrossRunGoalEvidence => {
                "proposed evidence belongs to a different run".to_string()
            }
            Self::UncommittedGoalEvidence => {
                "proposed evidence is not committed to the current task result".to_string()
            }
            Self::EvidenceCoverageMismatch => {
                "evidence does not cover the current task graph".to_string()
            }
            Self::MissingTaskEvidence(task_id) => {
                format!("task {task_id} has no committed evidence")
            }
            Self::UnknownEvidenceRequirement(task_id) => {
                format!("evidence references unknown task {task_id}")
            }
            Self::ReviewerBlockers(count) => {
                format!("{count} independent review blocker(s) remain")
            }
            Self::UnresolvedHighRiskWrites(count) => {
                format!("{count} high-risk write(s) remain unresolved")
            }
            Self::UncertainEffects(effects) => {
                format!(
                    "unresolved side effects require reconciliation: {}",
                    effects.join(", ")
                )
            }
            Self::StalePlanRevision => {
                "completion proposal targets a stale plan revision".to_string()
            }
            Self::StaleRequirementRevision => {
                "completion proposal does not target the current user requirement revision".to_string()
            }
            Self::UnknownRequirementSemantics(requirement_id) => {
                format!("requirement {requirement_id} has no current semantic contract; establish its content and target before proposing completion")
            }
            Self::UnknownRequirementEffect(requirement_id) => {
                format!("requirement {requirement_id} has no declared expected effect; specify its delivery before proposing completion")
            }
            Self::UnverifiedRequirements(requirements) => {
                format!("unverified requirement(s): {}", requirements.join(", "))
            }
            Self::RequirementCoverageMismatch => {
                "completion proposal does not cover the authoritative user requirement set"
                    .to_string()
            }
            Self::MissingRequirementEvidence(requirement_id) => {
                format!("requirement {requirement_id} has no cited evidence")
            }
            Self::MissingRequirementActionEvidence(requirement_id) => {
                format!("requirement {requirement_id} has no specific audited action coverage")
            }
            Self::RequirementEvidenceNotCommitted {
                requirement_id,
                task_id,
            } => format!(
                "requirement {requirement_id} cites evidence not committed to task {task_id}"
            ),
            Self::ExecutionObligationCoverageMismatch => {
                "completion proposal does not cover the authoritative execution obligation set"
                    .to_string()
            }
            Self::MissingExecutionObligationEvidence(obligation_id) => {
                format!("execution obligation {obligation_id} has no cited evidence")
            }
            Self::ExecutionObligationNotSatisfied(obligation_id) => {
                format!("execution obligation {obligation_id} has no matching successful receipt")
            }
            Self::ExecutionObligationEvidenceNotCommitted {
                obligation_id,
                task_id,
            } => format!(
                "execution obligation {obligation_id} cites evidence not committed to task {task_id}"
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvergenceAssessment {
    pub status: ConvergenceStatus,
    pub ready_task_ids: Vec<TaskId>,
    pub blockers: Vec<ConvergenceBlocker>,
}

pub struct ConvergenceEngine;

impl ConvergenceEngine {
    /// Diagnose already-known task blockers without committing the main task's
    /// proposed result. Evidence and effects still require the final assessment.
    pub(crate) fn pending_task_blockers(
        projection: &RunProjection,
        completion_task_id: &TaskId,
    ) -> Vec<ConvergenceBlocker> {
        let Ok(graph) = projection.current_task_graph() else {
            return vec![ConvergenceBlocker::MissingTopology];
        };
        let mut blockers = Vec::new();
        for task_id in graph.task_ids().filter(|id| *id != completion_task_id) {
            if let Some(blocker) = Self::task_blocker(projection, task_id, true) {
                blockers.push(blocker);
            }
        }
        blockers
    }

    fn task_blocker(
        projection: &RunProjection,
        task_id: &TaskId,
        evidence_required: bool,
    ) -> Option<ConvergenceBlocker> {
        let Some(task) = projection.tasks.get(task_id) else {
            return Some(ConvergenceBlocker::TaskNotSuccessful {
                task_id: task_id.clone(),
                state: TaskState::Proposed,
            });
        };
        if task.state != TaskState::Succeeded {
            return Some(ConvergenceBlocker::TaskNotSuccessful {
                task_id: task_id.clone(),
                state: task.state,
            });
        }
        (evidence_required
            && task
                .result
                .as_ref()
                .is_none_or(|result| result.evidence_refs.is_empty()))
        .then(|| ConvergenceBlocker::MissingTaskEvidence(task_id.clone()))
    }

    pub fn assess(
        projection: &RunProjection,
        requirements: &CompletionRequirements,
    ) -> ConvergenceAssessment {
        let graph = match projection.current_task_graph() {
            Ok(graph) => graph,
            Err(_) => {
                return ConvergenceAssessment {
                    status: if projection.state == RunState::Planning {
                        ConvergenceStatus::InProgress
                    } else {
                        ConvergenceStatus::Blocked
                    },
                    ready_task_ids: vec![],
                    blockers: vec![ConvergenceBlocker::MissingTopology],
                };
            }
        };
        let states = projection
            .tasks
            .iter()
            .map(|(task_id, task)| (task_id.clone(), task.state))
            .collect::<BTreeMap<_, _>>();
        let ready_task_ids = if projection.state == RunState::Running {
            graph.ready_task_ids(&states).unwrap_or_default()
        } else {
            vec![]
        };
        let mut blockers = Vec::new();
        if requirements.plan_revision != Some(projection.plan_revision) {
            blockers.push(ConvergenceBlocker::StalePlanRevision);
        }
        let graph_task_ids = graph.task_ids().cloned().collect::<BTreeSet<_>>();
        if requirements.evidence_required_tasks != graph_task_ids {
            blockers.push(ConvergenceBlocker::EvidenceCoverageMismatch);
        }
        if !requirements.unverified_requirements.is_empty() {
            blockers.push(ConvergenceBlocker::UnverifiedRequirements(
                requirements.unverified_requirements.clone(),
            ));
        }
        if let Some(completion_task_id) = requirements.completion_task_id.as_ref() {
            if requirements.requirement_revision != Some(projection.user_requirement_revision) {
                blockers.push(ConvergenceBlocker::StaleRequirementRevision);
            }
            if projection.user_requirements.is_empty() {
                blockers.push(ConvergenceBlocker::UnknownRequirementSemantics(
                    ROOT_USER_REQUIREMENT_ID.to_string(),
                ));
            }
            for requirement in projection
                .user_requirements
                .values()
                .filter(|requirement| requirement.is_active())
            {
                if requirement.semantics.is_none() {
                    blockers.push(ConvergenceBlocker::UnknownRequirementSemantics(
                        requirement.requirement_id.clone(),
                    ));
                } else if requirement
                    .semantics
                    .as_ref()
                    .is_none_or(|semantics| semantics.expected_effect.is_none())
                {
                    blockers.push(ConvergenceBlocker::UnknownRequirementEffect(
                        requirement.requirement_id.clone(),
                    ));
                } else if requirements
                    .requirement_claims
                    .iter()
                    .find(|coverage| coverage.requirement_id == requirement.requirement_id)
                    .is_none_or(|coverage| coverage.audit_ids.is_empty())
                {
                    blockers.push(ConvergenceBlocker::MissingRequirementActionEvidence(
                        requirement.requirement_id.clone(),
                    ));
                }
            }
            let authoritative_requirements = if projection.user_requirements.is_empty() {
                BTreeSet::from([ROOT_USER_REQUIREMENT_ID.to_string()])
            } else {
                projection
                    .user_requirements
                    .iter()
                    .filter(|(_, requirement)| requirement.is_active())
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            let proposed_requirements = requirements
                .requirement_coverage
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>();
            if projection.goal.trim().is_empty()
                || proposed_requirements != authoritative_requirements
            {
                blockers.push(ConvergenceBlocker::RequirementCoverageMismatch);
            }
            if let Some(task) = projection.tasks.get(completion_task_id) {
                for (requirement_id, evidence_refs) in &requirements.requirement_coverage {
                    if evidence_refs.is_empty() {
                        blockers.push(ConvergenceBlocker::MissingRequirementEvidence(
                            requirement_id.clone(),
                        ));
                    } else if task.result.as_ref().is_none_or(|result| {
                        evidence_refs
                            .iter()
                            .any(|evidence| !result.evidence_refs.contains(evidence))
                    }) {
                        blockers.push(ConvergenceBlocker::RequirementEvidenceNotCommitted {
                            requirement_id: requirement_id.clone(),
                            task_id: completion_task_id.clone(),
                        });
                    }
                }
                let authoritative_obligations = projection
                    .execution_obligations
                    .keys()
                    .cloned()
                    .collect::<BTreeSet<_>>();
                let proposed_obligations = requirements
                    .execution_obligation_coverage
                    .keys()
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if proposed_obligations != authoritative_obligations {
                    blockers.push(ConvergenceBlocker::ExecutionObligationCoverageMismatch);
                }
                for (obligation_id, coverage) in &requirements.execution_obligation_coverage {
                    let Some(obligation) = projection.execution_obligations.get(obligation_id)
                    else {
                        continue;
                    };
                    if coverage.evidence_refs.is_empty() {
                        blockers.push(ConvergenceBlocker::MissingExecutionObligationEvidence(
                            obligation_id.clone(),
                        ));
                    } else if task.result.as_ref().is_none_or(|result| {
                        coverage
                            .evidence_refs
                            .iter()
                            .any(|evidence| !result.evidence_refs.contains(evidence))
                    }) {
                        blockers.push(
                            ConvergenceBlocker::ExecutionObligationEvidenceNotCommitted {
                                obligation_id: obligation_id.clone(),
                                task_id: completion_task_id.clone(),
                            },
                        );
                    }
                    let invocation_matches = if obligation.allow_equivalent_invocation {
                        coverage.invocation.validation_identity()
                            == obligation.invocation.validation_identity()
                    } else {
                        coverage.invocation.exact_match(&obligation.invocation)
                    };
                    let evidence_matches = match obligation.evidence_requirement {
                        crate::agents::protocol::EvidenceRequirement::ExitCodeObserved => true,
                        crate::agents::protocol::EvidenceRequirement::SuccessfulExitCode => {
                            coverage.exit_code == 0
                        }
                    };
                    if !evidence_matches || !invocation_matches {
                        blockers.push(ConvergenceBlocker::ExecutionObligationNotSatisfied(
                            obligation_id.clone(),
                        ));
                    }
                }
            }
        }
        let mut has_active_work = false;

        if !matches!(
            projection.state,
            RunState::Running | RunState::Completing | RunState::Completed
        ) {
            if matches!(projection.state, RunState::Planning | RunState::Recovering) {
                has_active_work = true;
            } else {
                blockers.push(ConvergenceBlocker::RunNotConvergent(projection.state));
            }
        }

        for task_id in graph.task_ids() {
            if projection.tasks.get(task_id).is_some_and(|task| {
                matches!(
                    task.state,
                    TaskState::Proposed | TaskState::Ready | TaskState::Running
                )
            }) {
                has_active_work = true;
            }
            if let Some(blocker) = Self::task_blocker(
                projection,
                task_id,
                requirements.evidence_required_tasks.contains(task_id),
            ) {
                blockers.push(blocker);
            }
        }
        for task_id in &requirements.evidence_required_tasks {
            if !graph.contains_task(task_id) {
                blockers.push(ConvergenceBlocker::UnknownEvidenceRequirement(
                    task_id.clone(),
                ));
            }
        }
        if requirements.goal_evidence.is_empty() {
            blockers.push(ConvergenceBlocker::MissingGoalEvidence);
        } else if requirements
            .goal_evidence
            .iter()
            .any(|evidence| evidence.validate_for_run(&projection.run_id).is_err())
        {
            blockers.push(ConvergenceBlocker::CrossRunGoalEvidence);
        } else if requirements.goal_evidence.iter().any(|evidence| {
            !projection.tasks.values().any(|task| {
                task.result
                    .as_ref()
                    .is_some_and(|result| result.evidence_refs.contains(evidence))
            })
        }) {
            blockers.push(ConvergenceBlocker::UncommittedGoalEvidence);
        }
        if !requirements.reviewer_blockers.is_empty() {
            blockers.push(ConvergenceBlocker::ReviewerBlockers(
                requirements.reviewer_blockers.len(),
            ));
        }
        if !requirements.unresolved_high_risk_writes.is_empty() {
            blockers.push(ConvergenceBlocker::UnresolvedHighRiskWrites(
                requirements.unresolved_high_risk_writes.len(),
            ));
        }
        if !requirements.uncertain_effects.is_empty() {
            blockers.push(ConvergenceBlocker::UncertainEffects(
                requirements.uncertain_effects.clone(),
            ));
        }
        let status = if has_active_work {
            ConvergenceStatus::InProgress
        } else if blockers.is_empty() {
            ConvergenceStatus::Eligible
        } else {
            ConvergenceStatus::Blocked
        };
        ConvergenceAssessment {
            status,
            ready_task_ids,
            blockers,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::protocol::{
        EventId, EvidenceRequirement, ExecutionObligation, ProtocolVersion, RunEvent,
        RunEventPayload, TaskDependency, TaskResult,
    };
    use crate::agents::validation_invocation::ValidationInvocation;
    use chrono::Utc;
    use std::path::Path;

    fn event(
        run_id: &RunId,
        sequence: u64,
        task_id: Option<&TaskId>,
        payload: RunEventPayload,
    ) -> RunEvent {
        let event_id = EventId::new(format!("event-{sequence}")).unwrap();
        RunEvent {
            protocol_version: ProtocolVersion::CURRENT,
            run_id: run_id.clone(),
            event_id: event_id.clone(),
            sequence,
            task_id: task_id.cloned(),
            agent_id: None,
            causation_id: None,
            correlation_id: event_id,
            occurred_at: Utc::now(),
            payload,
            evidence_refs: Vec::new(),
        }
    }

    fn completed_projection() -> (RunProjection, TaskId, EvidenceRef) {
        let run_id = RunId::new("run-first-repair").unwrap();
        let task_id = TaskId::new("task-main").unwrap();
        let evidence = EvidenceRef::new(
            run_id.clone(),
            EventId::new("evidence-main").unwrap(),
            "artifacts/main.json".to_string(),
        )
        .unwrap();
        let events = vec![
            event(
                &run_id,
                1,
                None,
                RunEventPayload::RunStarted {
                    goal: "run the requested validation".to_string(),
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
                    name: "main Agent root".to_string(),
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
                        depends_on: Vec::new(),
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
            event(
                &run_id,
                6,
                Some(&task_id),
                RunEventPayload::TaskStateChanged {
                    task_id: task_id.clone(),
                    from: TaskState::Proposed,
                    to: TaskState::Ready,
                },
            ),
            event(
                &run_id,
                7,
                Some(&task_id),
                RunEventPayload::TaskStateChanged {
                    task_id: task_id.clone(),
                    from: TaskState::Ready,
                    to: TaskState::Running,
                },
            ),
            event(
                &run_id,
                8,
                Some(&task_id),
                RunEventPayload::TaskSucceeded {
                    task_id: task_id.clone(),
                    result: TaskResult {
                        summary: "evidence committed".to_string(),
                        evidence_refs: vec![evidence.clone()],
                    },
                },
            ),
        ];
        let mut projection = RunProjection::rebuild(&events).unwrap();
        projection.user_requirement_revision = 1;
        projection.user_requirements.insert(
            ROOT_USER_REQUIREMENT_ID.to_string(),
            crate::agents::protocol::UserRequirement {
                requirement_id: ROOT_USER_REQUIREMENT_ID.to_string(),
                source_message_id: "message-1".to_string(),
                continuation_source: None,
                semantics: Some(crate::agents::protocol::RequirementSemantics {
                    content: "Diagnose the test result".to_string(),
                    expected_effect: Some(crate::agents::protocol::RequirementEffect::Observation),
                    target_resources: vec!["C:/workspace".to_string()],
                    revision_relation: None,
                }),
                execution_obligations: Vec::new(),
            },
        );
        (projection, task_id, evidence)
    }

    fn obligation(command: &str, evidence_requirement: EvidenceRequirement) -> ExecutionObligation {
        ExecutionObligation {
            obligation_id: "run-goal:validation:1".to_string(),
            source_message_id: "message-1".to_string(),
            invocation: ValidationInvocation::parse(command, Path::new("C:/workspace")).unwrap(),
            evidence_requirement,
            allow_equivalent_invocation: false,
        }
    }

    fn coverage(
        obligation: &ExecutionObligation,
        command: &str,
        exit_code: i32,
        evidence: EvidenceRef,
    ) -> ExecutionObligationEvidenceCoverage {
        ExecutionObligationEvidenceCoverage {
            obligation_id: obligation.obligation_id.clone(),
            evidence_refs: vec![evidence],
            audit_id: "audit-validation-1".to_string(),
            invocation: ValidationInvocation::parse(command, Path::new("C:/workspace")).unwrap(),
            exit_code,
        }
    }

    fn assessment_with(
        obligation: ExecutionObligation,
        coverage: ExecutionObligationEvidenceCoverage,
    ) -> ConvergenceAssessment {
        let (mut projection, task_id, evidence) = completed_projection();
        projection
            .execution_obligations
            .insert(obligation.obligation_id.clone(), obligation);
        let proposal = CompletionProposal::for_main_agent_with_coverage(
            &projection,
            task_id,
            vec![RequirementEvidenceCoverage {
                requirement_id: ROOT_USER_REQUIREMENT_ID.to_string(),
                evidence_refs: vec![evidence],
                audit_ids: vec!["audit-validation-1".to_string()],
                resource_versions: BTreeMap::new(),
            }],
            vec![coverage],
        );
        ConvergenceEngine::assess(
            &projection,
            &CompletionRequirements::host_derived(&projection, &proposal),
        )
    }

    #[test]
    fn first_repair_batch_missing_success_evidence_blocks_completion() {
        let (_, _, evidence) = completed_projection();
        let obligation = obligation("npm.cmd test", EvidenceRequirement::SuccessfulExitCode);
        let assessment = assessment_with(
            obligation.clone(),
            coverage(&obligation, "npm.cmd test", 1, evidence),
        );

        assert_eq!(assessment.status, ConvergenceStatus::Blocked);
        assert!(assessment.blockers.contains(
            &ConvergenceBlocker::ExecutionObligationNotSatisfied(obligation.obligation_id)
        ));
    }

    #[test]
    fn first_repair_batch_other_validation_cannot_replace_specified_obligation() {
        let (_, _, evidence) = completed_projection();
        let obligation = obligation("npm.cmd test", EvidenceRequirement::SuccessfulExitCode);
        let assessment = assessment_with(
            obligation.clone(),
            coverage(&obligation, "node --test", 0, evidence),
        );

        assert_eq!(assessment.status, ConvergenceStatus::Blocked);
        assert!(assessment.blockers.contains(
            &ConvergenceBlocker::ExecutionObligationNotSatisfied(obligation.obligation_id)
        ));
    }

    #[test]
    fn first_repair_batch_diagnostic_completion_is_separate_from_project_health() {
        let (_, _, evidence) = completed_projection();
        let obligation = obligation("npm.cmd test", EvidenceRequirement::ExitCodeObserved);
        let assessment = assessment_with(
            obligation.clone(),
            coverage(&obligation, "npm.cmd test", 1, evidence),
        );

        assert_eq!(assessment.status, ConvergenceStatus::Eligible);
    }

    #[test]
    fn r3_completion_rejects_old_requirement_revision_and_automatic_coverage() {
        let (projection, task_id, evidence) = completed_projection();
        let automatic = CompletionProposal::for_main_agent(
            &projection,
            task_id.clone(),
            vec![evidence.clone()],
        );
        assert!(automatic.requirement_coverage.is_empty());
        let assessment = ConvergenceEngine::assess(
            &projection,
            &CompletionRequirements::host_derived(&projection, &automatic),
        );
        assert!(assessment
            .blockers
            .contains(&ConvergenceBlocker::RequirementCoverageMismatch));

        let mut proposal = CompletionProposal::for_main_agent_with_coverage(
            &projection,
            task_id,
            vec![RequirementEvidenceCoverage {
                requirement_id: ROOT_USER_REQUIREMENT_ID.to_string(),
                evidence_refs: vec![evidence],
                audit_ids: vec!["audit-validation-1".to_string()],
                resource_versions: BTreeMap::new(),
            }],
            Vec::new(),
        );
        proposal.requirement_revision = Some(0);
        let assessment = ConvergenceEngine::assess(
            &projection,
            &CompletionRequirements::host_derived(&projection, &proposal),
        );
        assert!(assessment
            .blockers
            .contains(&ConvergenceBlocker::StaleRequirementRevision));
    }

    #[test]
    fn r3_requirement_revision_cannot_silently_drop_an_existing_goal() {
        use crate::agents::protocol::{RequirementRevisionKind, RequirementRevisionRelation};
        let (projection, _, _) = completed_projection();
        let mut replacement = projection.user_requirements[ROOT_USER_REQUIREMENT_ID].clone();
        replacement.requirement_id = "new-goal".to_string();
        replacement.semantics.as_mut().unwrap().content =
            "Build the replacement application".to_string();
        assert!(projection
            .validate_requirement_revision(&[replacement.clone()])
            .is_err());
        replacement.semantics.as_mut().unwrap().revision_relation =
            Some(RequirementRevisionRelation {
                previous_revision: 1,
                requirement_ids: vec![ROOT_USER_REQUIREMENT_ID.to_string()],
                kind: RequirementRevisionKind::Replaced,
            });
        assert!(projection
            .validate_requirement_revision(&[replacement])
            .is_ok());
    }

    #[test]
    fn r3_old_requirement_projection_remains_readable_but_cannot_newly_complete() {
        let (projection, task_id, evidence) = completed_projection();
        let mut legacy = serde_json::to_value(&projection).unwrap();
        legacy["user_requirements"][ROOT_USER_REQUIREMENT_ID] =
            serde_json::Value::String("message-1".to_string());
        let restored: RunProjection = serde_json::from_value(legacy).unwrap();
        assert!(restored.user_requirements[ROOT_USER_REQUIREMENT_ID]
            .semantics
            .is_none());
        let proposal = CompletionProposal::for_main_agent_with_coverage(
            &restored,
            task_id,
            vec![RequirementEvidenceCoverage {
                requirement_id: ROOT_USER_REQUIREMENT_ID.to_string(),
                evidence_refs: vec![evidence],
                audit_ids: vec!["audit-validation-1".to_string()],
                resource_versions: BTreeMap::new(),
            }],
            Vec::new(),
        );
        let assessment = ConvergenceEngine::assess(
            &restored,
            &CompletionRequirements::host_derived(&restored, &proposal),
        );
        assert!(assessment
            .blockers
            .contains(&ConvergenceBlocker::UnknownRequirementSemantics(
                ROOT_USER_REQUIREMENT_ID.to_string()
            )));
    }

    #[test]
    fn r3_a_successful_action_cannot_complete_an_untyped_expected_effect() {
        let (mut projection, task_id, evidence) = completed_projection();
        projection
            .user_requirements
            .get_mut(ROOT_USER_REQUIREMENT_ID)
            .unwrap()
            .semantics
            .as_mut()
            .unwrap()
            .expected_effect = None;
        let proposal = CompletionProposal::for_main_agent_with_coverage(
            &projection,
            task_id,
            vec![RequirementEvidenceCoverage {
                requirement_id: ROOT_USER_REQUIREMENT_ID.to_string(),
                evidence_refs: vec![evidence],
                audit_ids: vec!["some-successful-action".to_string()],
                resource_versions: BTreeMap::new(),
            }],
            Vec::new(),
        );
        let assessment = ConvergenceEngine::assess(
            &projection,
            &CompletionRequirements::host_derived(&projection, &proposal),
        );
        assert!(assessment
            .blockers
            .contains(&ConvergenceBlocker::UnknownRequirementEffect(
                ROOT_USER_REQUIREMENT_ID.to_string()
            )));
    }

    #[test]
    fn r3_retained_requirement_cannot_change_the_expected_effect() {
        use crate::agents::protocol::{
            RequirementEffect, RequirementRevisionKind, RequirementRevisionRelation,
        };
        let (projection, _, _) = completed_projection();
        let mut retained = projection.user_requirements[ROOT_USER_REQUIREMENT_ID].clone();
        let semantics = retained.semantics.as_mut().unwrap();
        semantics.expected_effect = Some(RequirementEffect::WorkspaceChange);
        semantics.revision_relation = Some(RequirementRevisionRelation {
            previous_revision: 1,
            requirement_ids: vec![ROOT_USER_REQUIREMENT_ID.to_string()],
            kind: RequirementRevisionKind::Retained,
        });
        assert!(projection
            .validate_requirement_revision(&[retained])
            .is_err());
    }
}
