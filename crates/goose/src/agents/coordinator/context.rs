use crate::agents::protocol::RunId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const ABSOLUTE_CONTEXT_LIMIT_TOKENS: usize = 16_000;
const MODEL_CONTEXT_PERCENT: usize = 20;
const FALLBACK_USABLE_PERCENT: usize = 80;
const PROMPT_OVERHEAD_RESERVE_TOKENS: usize = 512;
const MAX_CONTEXT_RECORDS: usize = 128;
const MAX_CONTEXT_TEXT_BYTES: usize = 4_096;
const MAX_CONTEXT_ID_BYTES: usize = 128;

pub trait TokenEstimator: Send + Sync {
    fn estimate_tokens(&self, value: &str) -> usize;
    fn is_reliable(&self) -> bool;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ConservativeTokenEstimator;

impl TokenEstimator for ConservativeTokenEstimator {
    fn estimate_tokens(&self, value: &str) -> usize {
        value.len().div_ceil(3)
    }

    fn is_reliable(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorContextBudget {
    pub hard_limit_tokens: usize,
    pub usable_tokens: usize,
    pub fallback_reserve_applied: bool,
}

impl CoordinatorContextBudget {
    pub fn for_model(
        model_context_limit_tokens: usize,
        reliable_estimator: bool,
    ) -> Result<Self, ContextBuildError> {
        let proportional = model_context_limit_tokens
            .checked_mul(MODEL_CONTEXT_PERCENT)
            .ok_or(ContextBuildError::InvalidBudget)?
            / 100;
        let hard_limit_tokens = proportional.min(ABSOLUTE_CONTEXT_LIMIT_TOKENS);
        if hard_limit_tokens <= PROMPT_OVERHEAD_RESERVE_TOKENS {
            return Err(ContextBuildError::InvalidBudget);
        }
        let fallback_reserve_applied = !reliable_estimator;
        let usable_tokens = if fallback_reserve_applied {
            hard_limit_tokens
                .checked_mul(FALLBACK_USABLE_PERCENT)
                .ok_or(ContextBuildError::InvalidBudget)?
                / 100
        } else {
            hard_limit_tokens
        };
        Ok(Self {
            hard_limit_tokens,
            usable_tokens,
            fallback_reserve_applied,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRisk {
    Low,
    Medium,
    High,
    Uncertain,
}

impl ContextRisk {
    fn is_mandatory(self) -> bool {
        matches!(self, Self::High | Self::Uncertain)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextRecord {
    pub id: String,
    pub summary: String,
    pub risk: ContextRisk,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPlanSummary {
    pub revision: u32,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoordinatorContextInput {
    pub run_id: RunId,
    pub user_goal: String,
    pub hard_constraints: Vec<String>,
    pub security_policy: Vec<String>,
    pub current_plan: HostPlanSummary,
    pub recent_events: Vec<ContextRecord>,
    pub task_outcomes: Vec<ContextRecord>,
    pub active_agents: Vec<ContextRecord>,
    pub open_blockers: Vec<ContextRecord>,
    pub evidence: Vec<ContextRecord>,
    pub open_permissions: Vec<String>,
    pub budget_state: String,
    pub workspace_state: String,
    pub unresolved_high_risk_writes: Vec<String>,
    pub uncertain_effects: Vec<String>,
    pub user_steering: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ContextTrimReport {
    pub dropped_by_section: BTreeMap<String, usize>,
    pub truncated_by_section: BTreeMap<String, usize>,
    pub original_estimated_tokens: usize,
    pub retained_estimated_tokens: usize,
}

impl ContextTrimReport {
    pub fn total_dropped(&self) -> usize {
        self.dropped_by_section.values().sum()
    }

    fn dropped(&mut self, section: &str, count: usize) {
        if count > 0 {
            *self
                .dropped_by_section
                .entry(section.to_string())
                .or_default() += count;
        }
    }

    fn truncated(&mut self, section: &str) {
        *self
            .truncated_by_section
            .entry(section.to_string())
            .or_default() += 1;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorContext {
    pub run_id: RunId,
    pub user_goal: String,
    pub hard_constraints: Vec<String>,
    pub security_policy: Vec<String>,
    pub current_plan: HostPlanSummary,
    pub recent_events: Vec<ContextRecord>,
    pub task_outcomes: Vec<ContextRecord>,
    pub active_agents: Vec<ContextRecord>,
    pub open_blockers: Vec<ContextRecord>,
    pub evidence: Vec<ContextRecord>,
    pub open_permissions: Vec<String>,
    pub budget_state: String,
    pub workspace_state: String,
    pub unresolved_high_risk_writes: Vec<String>,
    pub uncertain_effects: Vec<String>,
    pub user_steering: Option<String>,
    pub budget: CoordinatorContextBudget,
    pub trim_report: ContextTrimReport,
    pub estimated_tokens: usize,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ContextBuildError {
    #[error("coordinator context budget is too small or overflowed")]
    InvalidBudget,
    #[error("mandatory coordinator context exceeds the available token budget")]
    MandatoryOverflow,
    #[error("required coordinator context field is empty: {0}")]
    EmptyRequiredField(&'static str),
    #[error("coordinator context contains duplicate record id: {0}")]
    DuplicateRecord(String),
    #[error("coordinator context limit exceeded for {field}: {actual} > {maximum}")]
    LimitExceeded {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    #[error("coordinator context serialization failed: {0}")]
    Serialization(String),
}

pub struct CoordinatorContextBuilder {
    budget: CoordinatorContextBudget,
}

impl CoordinatorContextBuilder {
    pub fn new(budget: CoordinatorContextBudget) -> Self {
        Self { budget }
    }

    pub fn build<E: TokenEstimator>(
        &self,
        input: CoordinatorContextInput,
        estimator: &E,
    ) -> Result<CoordinatorContext, ContextBuildError> {
        validate_input(&input)?;
        let original_estimated_tokens = estimate_input(&input, estimator)?;
        let mut trim_report = ContextTrimReport::default();
        let recent_events = fit_records(
            "recent_events",
            input.recent_events,
            32,
            2_000,
            2_000,
            estimator,
            &mut trim_report,
        )?;
        let task_outcomes = fit_records(
            "task_outcomes",
            input.task_outcomes,
            MAX_CONTEXT_RECORDS,
            4_000,
            400,
            estimator,
            &mut trim_report,
        )?;
        let evidence = fit_records(
            "evidence",
            input.evidence,
            32,
            1_500,
            1_500,
            estimator,
            &mut trim_report,
        )?;
        let active_agents = fit_records(
            "active_agents",
            input.active_agents,
            MAX_CONTEXT_RECORDS,
            1_250,
            400,
            estimator,
            &mut trim_report,
        )?;
        let open_blockers = fit_records(
            "open_blockers",
            input.open_blockers,
            MAX_CONTEXT_RECORDS,
            1_250,
            400,
            estimator,
            &mut trim_report,
        )?;
        let user_steering = input.user_steering.map(|value| {
            truncate_to_tokens("user_steering", value, 1_000, estimator, &mut trim_report)
        });

        let mut context = CoordinatorContext {
            run_id: input.run_id,
            user_goal: input.user_goal,
            hard_constraints: input.hard_constraints,
            security_policy: input.security_policy,
            current_plan: input.current_plan,
            recent_events,
            task_outcomes,
            active_agents,
            open_blockers,
            evidence,
            open_permissions: input.open_permissions,
            budget_state: input.budget_state,
            workspace_state: input.workspace_state,
            unresolved_high_risk_writes: input.unresolved_high_risk_writes,
            uncertain_effects: input.uncertain_effects,
            user_steering,
            budget: self.budget,
            trim_report,
            estimated_tokens: 0,
        };
        shrink_runtime_budget(&mut context, estimator)?;
        context.trim_report.original_estimated_tokens = original_estimated_tokens;
        shrink_to_total_budget(&mut context, estimator)?;
        context.estimated_tokens = estimate_context(&context, estimator)?;
        context.trim_report.retained_estimated_tokens = context.estimated_tokens;
        if context.estimated_tokens > context.budget.usable_tokens {
            return Err(ContextBuildError::MandatoryOverflow);
        }
        Ok(context)
    }
}

fn validate_input(input: &CoordinatorContextInput) -> Result<(), ContextBuildError> {
    for (field, value) in [
        ("user_goal", input.user_goal.as_str()),
        ("current_plan.summary", input.current_plan.summary.as_str()),
        ("budget_state", input.budget_state.as_str()),
        ("workspace_state", input.workspace_state.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(ContextBuildError::EmptyRequiredField(field));
        }
        validate_length(field, value.len(), MAX_CONTEXT_TEXT_BYTES)?;
    }
    if input.current_plan.revision == 0 {
        return Err(ContextBuildError::EmptyRequiredField(
            "current_plan.revision",
        ));
    }
    for (field, values) in [
        ("hard_constraints", input.hard_constraints.as_slice()),
        ("security_policy", input.security_policy.as_slice()),
        ("open_permissions", input.open_permissions.as_slice()),
        (
            "unresolved_high_risk_writes",
            input.unresolved_high_risk_writes.as_slice(),
        ),
        ("uncertain_effects", input.uncertain_effects.as_slice()),
    ] {
        if values.iter().any(|value| value.trim().is_empty()) {
            return Err(ContextBuildError::EmptyRequiredField(field));
        }
        validate_length(field, values.len(), MAX_CONTEXT_RECORDS)?;
        for value in values {
            validate_length(field, value.len(), MAX_CONTEXT_TEXT_BYTES)?;
        }
    }
    let mut ids = BTreeSet::new();
    for (field, records) in [
        ("recent_events", input.recent_events.as_slice()),
        ("task_outcomes", input.task_outcomes.as_slice()),
        ("active_agents", input.active_agents.as_slice()),
        ("open_blockers", input.open_blockers.as_slice()),
        ("evidence", input.evidence.as_slice()),
    ] {
        validate_length(field, records.len(), MAX_CONTEXT_RECORDS)?;
        for record in records {
            if record.id.trim().is_empty() || record.summary.trim().is_empty() {
                return Err(ContextBuildError::EmptyRequiredField("context_record"));
            }
            validate_length("context_record.id", record.id.len(), MAX_CONTEXT_ID_BYTES)?;
            validate_length(
                "context_record.summary",
                record.summary.len(),
                MAX_CONTEXT_TEXT_BYTES,
            )?;
            if !ids.insert(record.id.clone()) {
                return Err(ContextBuildError::DuplicateRecord(record.id.clone()));
            }
        }
    }
    Ok(())
}

fn validate_length(
    field: &'static str,
    actual: usize,
    maximum: usize,
) -> Result<(), ContextBuildError> {
    if actual <= maximum {
        Ok(())
    } else {
        Err(ContextBuildError::LimitExceeded {
            field,
            actual,
            maximum,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn fit_records<E: TokenEstimator>(
    section: &str,
    records: Vec<ContextRecord>,
    max_items: usize,
    max_section_tokens: usize,
    max_item_tokens: usize,
    estimator: &E,
    report: &mut ContextTrimReport,
) -> Result<Vec<ContextRecord>, ContextBuildError> {
    let mut indexed = records
        .into_iter()
        .enumerate()
        .map(|(index, mut record)| {
            let summary = std::mem::take(&mut record.summary);
            record.summary =
                truncate_to_tokens(section, summary, max_item_tokens, estimator, report);
            (index, record)
        })
        .collect::<Vec<_>>();
    let mandatory_count = indexed
        .iter()
        .filter(|(_, record)| record.risk.is_mandatory())
        .count();
    if mandatory_count > max_items {
        return Err(ContextBuildError::MandatoryOverflow);
    }
    if indexed.len() > max_items {
        let mut keep = indexed
            .iter()
            .filter(|(_, record)| record.risk.is_mandatory())
            .map(|(index, _)| *index)
            .collect::<BTreeSet<_>>();
        for (index, _) in indexed.iter().rev() {
            if keep.len() >= max_items {
                break;
            }
            keep.insert(*index);
        }
        let dropped = indexed.len() - keep.len();
        indexed.retain(|(index, _)| keep.contains(index));
        report.dropped(section, dropped);
    }
    while estimate_records(&indexed, estimator)? > max_section_tokens {
        let Some(position) = indexed
            .iter()
            .position(|(_, record)| !record.risk.is_mandatory())
        else {
            return Err(ContextBuildError::MandatoryOverflow);
        };
        indexed.remove(position);
        report.dropped(section, 1);
    }
    Ok(indexed.into_iter().map(|(_, record)| record).collect())
}

fn shrink_to_total_budget<E: TokenEstimator>(
    context: &mut CoordinatorContext,
    estimator: &E,
) -> Result<(), ContextBuildError> {
    while estimate_context(context, estimator)? > context.budget.usable_tokens {
        let removed = remove_optional(&mut context.task_outcomes)
            .then_some("task_outcomes")
            .or_else(|| remove_optional(&mut context.recent_events).then_some("recent_events"))
            .or_else(|| remove_optional(&mut context.evidence).then_some("evidence"))
            .or_else(|| remove_optional(&mut context.open_blockers).then_some("open_blockers"))
            .or_else(|| remove_optional(&mut context.active_agents).then_some("active_agents"));
        let Some(section) = removed else {
            return Err(ContextBuildError::MandatoryOverflow);
        };
        context.trim_report.dropped(section, 1);
    }
    Ok(())
}

fn shrink_runtime_budget<E: TokenEstimator>(
    context: &mut CoordinatorContext,
    estimator: &E,
) -> Result<(), ContextBuildError> {
    const MAX_RUNTIME_TOKENS: usize = 2_500;
    while estimate_runtime(context, estimator)? > MAX_RUNTIME_TOKENS {
        if !remove_optional(&mut context.active_agents) {
            return Err(ContextBuildError::MandatoryOverflow);
        }
        context.trim_report.dropped("active_agents", 1);
    }
    Ok(())
}

fn remove_optional(records: &mut Vec<ContextRecord>) -> bool {
    let position = records.iter().position(|record| {
        !record.risk.is_mandatory() && (record.terminal || record.risk == ContextRisk::Low)
    });
    if let Some(position) = position {
        records.remove(position);
        true
    } else {
        false
    }
}

fn truncate_to_tokens<E: TokenEstimator>(
    section: &str,
    value: String,
    maximum: usize,
    estimator: &E,
    report: &mut ContextTrimReport,
) -> String {
    if estimator.estimate_tokens(&value) <= maximum {
        return value;
    }
    let chars = value.chars().collect::<Vec<_>>();
    let mut low = 0;
    let mut high = chars.len();
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = chars[..middle].iter().collect::<String>();
        if estimator.estimate_tokens(&candidate) <= maximum {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    report.truncated(section);
    chars[..low].iter().collect()
}

fn estimate_records<E: TokenEstimator>(
    records: &[(usize, ContextRecord)],
    estimator: &E,
) -> Result<usize, ContextBuildError> {
    let serialized = serde_json::to_string(records)
        .map_err(|error| ContextBuildError::Serialization(error.to_string()))?;
    Ok(estimator.estimate_tokens(&serialized))
}

fn estimate_context<E: TokenEstimator>(
    context: &CoordinatorContext,
    estimator: &E,
) -> Result<usize, ContextBuildError> {
    let mut measurable = context.clone();
    measurable.estimated_tokens = 0;
    measurable.trim_report.original_estimated_tokens = 0;
    measurable.trim_report.retained_estimated_tokens = 0;
    let serialized = serde_json::to_string(&measurable)
        .map_err(|error| ContextBuildError::Serialization(error.to_string()))?;
    Ok(estimator
        .estimate_tokens(&serialized)
        .saturating_add(PROMPT_OVERHEAD_RESERVE_TOKENS))
}

fn estimate_input<E: TokenEstimator>(
    input: &CoordinatorContextInput,
    estimator: &E,
) -> Result<usize, ContextBuildError> {
    let serialized = serde_json::to_string(input)
        .map_err(|error| ContextBuildError::Serialization(error.to_string()))?;
    Ok(estimator
        .estimate_tokens(&serialized)
        .saturating_add(PROMPT_OVERHEAD_RESERVE_TOKENS))
}

fn estimate_runtime<E: TokenEstimator>(
    context: &CoordinatorContext,
    estimator: &E,
) -> Result<usize, ContextBuildError> {
    let serialized = serde_json::to_string(&(
        &context.active_agents,
        &context.open_permissions,
        &context.budget_state,
        &context.workspace_state,
    ))
    .map_err(|error| ContextBuildError::Serialization(error.to_string()))?;
    Ok(estimator.estimate_tokens(&serialized))
}
