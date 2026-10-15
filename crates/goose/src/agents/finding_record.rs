use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const FINDING_RECORD_SCHEMA_VERSION: u8 = 1;
pub const COVERAGE_RECORD_SCHEMA_VERSION: u8 = 1;
pub const FINDING_CANDIDATE_SCHEMA_VERSION: u8 = 1;
pub const FINDING_VALIDATION_SCHEMA_VERSION: u8 = 1;
pub const FINDING_REPLAY_CONTRACT_SCHEMA_VERSION: u8 = 1;
pub const FINDING_REPLAY_REVIEW_SCHEMA_VERSION: u8 = 1;
pub const FINDING_FINGERPRINT_INPUT_SCHEMA_VERSION: u8 = 1;
pub const FINDING_RUN_SNAPSHOT_SCHEMA_VERSION: u8 = 1;
pub const FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION: u8 = 1;
pub const FINDING_RUN_COMPARISON_SCHEMA_VERSION: u8 = 1;
pub const FINDING_FALSE_POSITIVE_SCHEMA_VERSION: u8 = 1;
pub const FINDING_CHECK_DEFINITION_SCHEMA_VERSION: u8 = 1;
pub const FINDING_RERUN_INPUT_SCHEMA_VERSION: u8 = 1;
const MAX_RECORD_ID_CHARS: usize = 128;
const MAX_TITLE_CHARS: usize = 256;
const MAX_SEVERITY_CHARS: usize = 32;
const MAX_DETAIL_CHARS: usize = 2_000;
const MAX_SUMMARY_CHARS: usize = 4_000;
const MAX_COMMAND_CHARS: usize = 4_096;
const MAX_PATH_CHARS: usize = 1_024;
const MAX_MISSING_EVIDENCE: usize = 20;
const MAX_MISSING_EVIDENCE_CHARS: usize = 512;
const MAX_DATA_FLOW_NODES: usize = 64;
const MAX_DATA_FLOW_NODE_CHARS: usize = 512;
const MAX_APPLICABILITY_CONDITIONS: usize = 32;
const MAX_CONDITION_KEY_CHARS: usize = 128;
const MAX_CONDITION_VALUE_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    ConfirmedBug,
    TestFailure,
    QualityFailure,
    EnvironmentProblem,
    AgentExecutionFailure,
    UnverifiedScenario,
    PassedCheck,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingLifecycle {
    New,
    Persisting,
    Reopened,
    Resolved,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub path: PathBuf,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationEvidence {
    pub command: String,
    pub working_directory: PathBuf,
    pub exit_code: Option<i32>,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub stdout_artifact: Option<PathBuf>,
    pub stderr_artifact: Option<PathBuf>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingFingerprintInput {
    pub schema_version: u8,
    pub root_cause: String,
    pub rule: String,
    pub location: SourceLocation,
    pub data_flow: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingRunSnapshot {
    pub schema_version: u8,
    pub fingerprint: String,
    pub run_id: String,
    pub lifecycle: FindingLifecycle,
    pub location: SourceLocation,
    pub validation_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingComparisonCoverage {
    pub schema_version: u8,
    pub run_id: String,
    pub reviewed_scope: Vec<PathBuf>,
    pub coverage_complete: bool,
    pub artifacts_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingRunComparison {
    pub schema_version: u8,
    pub fingerprint: String,
    pub lifecycle: FindingLifecycle,
    pub location: SourceLocation,
    pub previous_run: Option<String>,
    pub current_run: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingFalsePositive {
    pub schema_version: u8,
    pub fingerprint: String,
    pub reason: String,
    pub applicability: BTreeMap<String, String>,
    pub recorded_run: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingCheckDefinition {
    pub schema_version: u8,
    pub check_id: String,
    pub related_fingerprints: Vec<String>,
    pub watched_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingRerunInput {
    pub schema_version: u8,
    pub failed_fingerprints: Vec<String>,
    pub modified_paths: Vec<PathBuf>,
    pub checks: Vec<FindingCheckDefinition>,
}

pub fn false_positive_still_applies(
    record: &FindingFalsePositive,
    fingerprint: &str,
    reason: &str,
    applicability: &BTreeMap<String, String>,
) -> Result<bool, String> {
    validate_false_positive(record)?;
    if !valid_fingerprint(fingerprint)
        || !valid_text(reason, MAX_DETAIL_CHARS, false)
        || !valid_applicability(applicability)
    {
        return Err("当前误报适用条件无效或超过安全边界".to_string());
    }
    Ok(record.fingerprint == fingerprint
        && record.reason == reason
        && record.applicability == *applicability)
}

pub fn select_finding_reruns(input: &FindingRerunInput) -> Result<Vec<String>, String> {
    const MAX_FAILED_FINGERPRINTS: usize = 500;
    const MAX_MODIFIED_PATHS: usize = 1_000;
    const MAX_CHECKS: usize = 500;
    const MAX_CHECK_LINKS: usize = 500;
    if input.schema_version != FINDING_RERUN_INPUT_SCHEMA_VERSION
        || input.failed_fingerprints.len() > MAX_FAILED_FINGERPRINTS
        || !input
            .failed_fingerprints
            .iter()
            .all(|fingerprint| valid_fingerprint(fingerprint))
        || input.modified_paths.len() > MAX_MODIFIED_PATHS
        || !input
            .modified_paths
            .iter()
            .all(|path| valid_relative_path(path))
        || input.checks.len() > MAX_CHECKS
    {
        return Err("问题重跑输入无效或超过安全边界".to_string());
    }
    for check in &input.checks {
        if check.schema_version != FINDING_CHECK_DEFINITION_SCHEMA_VERSION
            || !valid_id(&check.check_id)
            || check.related_fingerprints.len() > MAX_CHECK_LINKS
            || !check
                .related_fingerprints
                .iter()
                .all(|fingerprint| valid_fingerprint(fingerprint))
            || check.watched_paths.len() > MAX_CHECK_LINKS
            || !check
                .watched_paths
                .iter()
                .all(|path| valid_relative_path(path))
        {
            return Err("问题检查定义无效或超过安全边界".to_string());
        }
    }
    let failed = input
        .failed_fingerprints
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let modified = input
        .modified_paths
        .iter()
        .map(|path| normalize_fingerprint_path(path))
        .collect::<BTreeSet<_>>();
    let selected = input
        .checks
        .iter()
        .filter(|check| {
            check
                .related_fingerprints
                .iter()
                .any(|fingerprint| failed.contains(fingerprint))
                || check
                    .watched_paths
                    .iter()
                    .map(|path| normalize_fingerprint_path(path))
                    .any(|path| modified.contains(&path))
        })
        .map(|check| check.check_id.clone())
        .collect::<BTreeSet<_>>();
    Ok(selected.into_iter().collect())
}

fn validate_false_positive(record: &FindingFalsePositive) -> Result<(), String> {
    let valid = record.schema_version == FINDING_FALSE_POSITIVE_SCHEMA_VERSION
        && valid_fingerprint(&record.fingerprint)
        && valid_text(&record.reason, MAX_DETAIL_CHARS, false)
        && valid_applicability(&record.applicability)
        && valid_id(&record.recorded_run);
    valid
        .then_some(())
        .ok_or_else(|| "误报记录无效或超过安全边界".to_string())
}

fn valid_applicability(applicability: &BTreeMap<String, String>) -> bool {
    !applicability.is_empty()
        && applicability.len() <= MAX_APPLICABILITY_CONDITIONS
        && applicability.iter().all(|(key, value)| {
            valid_single_line(key, MAX_CONDITION_KEY_CHARS)
                && valid_text(value, MAX_CONDITION_VALUE_CHARS, false)
        })
}

pub fn compare_finding_runs(
    previous: &[FindingRunSnapshot],
    current: &[FindingRunSnapshot],
    coverage: &FindingComparisonCoverage,
) -> Result<Vec<FindingRunComparison>, String> {
    const MAX_RUN_FINDINGS: usize = 2_000;
    const MAX_REVIEWED_SCOPE: usize = 2_000;
    if previous.len() > MAX_RUN_FINDINGS
        || current.len() > MAX_RUN_FINDINGS
        || coverage.schema_version != FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION
        || !valid_id(&coverage.run_id)
        || coverage.reviewed_scope.len() > MAX_REVIEWED_SCOPE
        || !coverage
            .reviewed_scope
            .iter()
            .all(|path| valid_relative_path(path))
    {
        return Err("跨运行比较输入无效或超过安全边界".to_string());
    }
    let previous = normalized_snapshot_map(previous)?;
    let current = normalized_snapshot_map(current)?;
    if current
        .values()
        .any(|snapshot| snapshot.run_id != coverage.run_id)
    {
        return Err("当前问题快照与覆盖记录运行 ID 不一致".to_string());
    }
    let reviewed_scope = coverage
        .reviewed_scope
        .iter()
        .map(|path| normalize_fingerprint_path(path))
        .collect::<BTreeSet<_>>();
    let keys = previous
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut comparisons = Vec::with_capacity(keys.len());
    for fingerprint in keys {
        let previous_snapshot = previous.get(&fingerprint);
        let current_snapshot = current.get(&fingerprint);
        let reference = current_snapshot
            .or(previous_snapshot)
            .expect("fingerprint came from one of the snapshot maps");
        let (lifecycle, reason) = match (previous_snapshot, current_snapshot) {
            (_, Some(current))
                if !current.validation_complete
                    || matches!(
                        current.lifecycle,
                        FindingLifecycle::Resolved | FindingLifecycle::Unknown
                    ) =>
            {
                (FindingLifecycle::Unknown, "当前运行的验证不完整或状态未知")
            }
            (None, Some(_)) => (FindingLifecycle::New, "当前运行首次出现"),
            (Some(previous), Some(_)) if previous.lifecycle == FindingLifecycle::Resolved => {
                (FindingLifecycle::Reopened, "已解决问题在当前运行再次出现")
            }
            (Some(previous), Some(_)) if previous.lifecycle == FindingLifecycle::Unknown => {
                (FindingLifecycle::Unknown, "历史状态未知，不能判断是否持续")
            }
            (Some(_), Some(_)) => (FindingLifecycle::Persisting, "相同宿主指纹仍然存在"),
            (Some(previous), None)
                if coverage.coverage_complete
                    && coverage.artifacts_complete
                    && reviewed_scope
                        .contains(&normalize_fingerprint_path(&previous.location.path)) =>
            {
                (FindingLifecycle::Resolved, "原位置已复查且完整证据未再复现")
            }
            (Some(_), None) => (
                FindingLifecycle::Unknown,
                "当前运行未覆盖原位置或验证制品不完整",
            ),
            (None, None) => unreachable!("fingerprint came from the union of both maps"),
        };
        comparisons.push(FindingRunComparison {
            schema_version: FINDING_RUN_COMPARISON_SCHEMA_VERSION,
            fingerprint,
            lifecycle,
            location: reference.location.clone(),
            previous_run: previous_snapshot.map(|snapshot| snapshot.run_id.clone()),
            current_run: current_snapshot.map(|snapshot| snapshot.run_id.clone()),
            reason: reason.to_string(),
        });
    }
    Ok(comparisons)
}

fn normalized_snapshot_map(
    snapshots: &[FindingRunSnapshot],
) -> Result<BTreeMap<String, FindingRunSnapshot>, String> {
    let mut normalized = BTreeMap::new();
    for snapshot in snapshots {
        if snapshot.schema_version != FINDING_RUN_SNAPSHOT_SCHEMA_VERSION
            || !valid_fingerprint(&snapshot.fingerprint)
            || !valid_id(&snapshot.run_id)
            || !valid_relative_path(&snapshot.location.path)
        {
            return Err("问题运行快照无效或超过安全边界".to_string());
        }
        match normalized.get_mut(&snapshot.fingerprint) {
            None => {
                normalized.insert(snapshot.fingerprint.clone(), snapshot.clone());
            }
            Some(existing) => {
                if existing.run_id != snapshot.run_id
                    || normalize_fingerprint_path(&existing.location.path)
                        != normalize_fingerprint_path(&snapshot.location.path)
                    || existing.lifecycle != snapshot.lifecycle
                {
                    return Err("同一指纹存在互相冲突的运行快照".to_string());
                }
                existing.validation_complete &= snapshot.validation_complete;
            }
        }
    }
    Ok(normalized)
}

fn valid_fingerprint(value: &str) -> bool {
    value.strip_prefix("b3:v1:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn generate_finding_fingerprint(input: &FindingFingerprintInput) -> Result<String, String> {
    if input.schema_version != FINDING_FINGERPRINT_INPUT_SCHEMA_VERSION
        || !valid_text(&input.root_cause, MAX_DETAIL_CHARS, false)
        || !valid_text(&input.rule, MAX_DETAIL_CHARS, false)
        || !valid_relative_path(&input.location.path)
        || input.data_flow.is_empty()
        || input.data_flow.len() > MAX_DATA_FLOW_NODES
        || !input
            .data_flow
            .iter()
            .all(|node| valid_text(node, MAX_DATA_FLOW_NODE_CHARS, false))
    {
        return Err("问题指纹输入无效或超过安全边界".to_string());
    }

    let root_cause = normalize_fingerprint_text(&input.root_cause);
    let rule = normalize_fingerprint_text(&input.rule);
    let location = normalize_fingerprint_path(&input.location.path);
    let data_flow = input
        .data_flow
        .iter()
        .map(|node| normalize_fingerprint_text(node))
        .collect::<Vec<_>>();
    if root_cause.is_empty()
        || rule.is_empty()
        || location.is_empty()
        || data_flow.iter().any(String::is_empty)
    {
        return Err("问题指纹规范化后包含空字段".to_string());
    }

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"codeagentpro:finding-fingerprint:v1");
    update_fingerprint_field(&mut hasher, b"root_cause", root_cause.as_bytes());
    update_fingerprint_field(&mut hasher, b"rule", rule.as_bytes());
    update_fingerprint_field(&mut hasher, b"location", location.as_bytes());
    hasher.update(&(data_flow.len() as u64).to_le_bytes());
    for node in data_flow {
        update_fingerprint_field(&mut hasher, b"data_flow", node.as_bytes());
    }
    Ok(format!("b3:v1:{}", hasher.finalize().to_hex()))
}

fn normalize_fingerprint_text(value: &str) -> String {
    value
        .nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_fingerprint_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn update_fingerprint_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingCandidate {
    pub schema_version: u8,
    pub candidate_id: String,
    pub run_id: String,
    pub task_id: String,
    pub title: String,
    pub severity: String,
    pub location: Option<SourceLocation>,
    pub observed_behavior: String,
    pub contract_reference: Option<String>,
    pub impact: String,
    pub validation_hint: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingValidationStatus {
    Confirmed,
    NotReproduced,
    EnvironmentBlocked,
    CoverageGap,
    AgentIncomplete,
    InsufficientEvidence,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingValidation {
    pub schema_version: u8,
    pub candidate_id: String,
    pub validator_task_id: String,
    pub status: FindingValidationStatus,
    pub evidence: Option<VerificationEvidence>,
    pub input_summary: String,
    pub output_summary: String,
    pub missing_evidence: Vec<String>,
    pub validated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingReplayContract {
    pub schema_version: u8,
    pub candidate_id: String,
    pub original_validator_task_id: String,
    pub original_validated_at: DateTime<Utc>,
    pub repair_task_id: String,
    pub replay_task_id: String,
    pub reviewer_task_id: String,
    pub location: SourceLocation,
    pub input_summary: String,
    pub command: String,
    pub working_directory: PathBuf,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingReplayReview {
    pub schema_version: u8,
    pub candidate_id: String,
    pub replay_task_id: String,
    pub reviewer_task_id: String,
    pub accepted: bool,
    pub summary: String,
    pub reviewed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingValidationDecisionReason {
    Confirmed,
    NotReproduced,
    EnvironmentBlocked,
    CoverageGap,
    AgentIncomplete,
    InsufficientEvidence,
    UnknownStatus,
    CandidateMismatch,
    MissingLocation,
    MissingContract,
    MissingHostEvidence,
    MissingInputSummary,
    MissingOutputSummary,
    InvalidCandidate,
    InvalidValidation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingValidationDecision {
    pub kind: FindingKind,
    pub confirmed: bool,
    pub reason: FindingValidationDecisionReason,
}

pub fn classify_finding_validation(
    candidate: &FindingCandidate,
    validation: &FindingValidation,
) -> FindingValidationDecision {
    if !valid_candidate(candidate) {
        return unverified(FindingValidationDecisionReason::InvalidCandidate);
    }
    if !valid_validation(candidate, validation) {
        return unverified(FindingValidationDecisionReason::InvalidValidation);
    }
    if candidate.candidate_id != validation.candidate_id {
        return unverified(FindingValidationDecisionReason::CandidateMismatch);
    }

    match validation.status {
        FindingValidationStatus::Confirmed => classify_confirmed(candidate, validation),
        FindingValidationStatus::NotReproduced => {
            unverified(FindingValidationDecisionReason::NotReproduced)
        }
        FindingValidationStatus::EnvironmentBlocked => FindingValidationDecision {
            kind: FindingKind::EnvironmentProblem,
            confirmed: false,
            reason: FindingValidationDecisionReason::EnvironmentBlocked,
        },
        FindingValidationStatus::CoverageGap => {
            unverified(FindingValidationDecisionReason::CoverageGap)
        }
        FindingValidationStatus::AgentIncomplete => FindingValidationDecision {
            kind: FindingKind::AgentExecutionFailure,
            confirmed: false,
            reason: FindingValidationDecisionReason::AgentIncomplete,
        },
        FindingValidationStatus::InsufficientEvidence => {
            unverified(FindingValidationDecisionReason::InsufficientEvidence)
        }
        FindingValidationStatus::Unknown => {
            unverified(FindingValidationDecisionReason::UnknownStatus)
        }
    }
}

pub fn validate_finding_candidate(candidate: &FindingCandidate) -> Result<(), String> {
    valid_candidate(candidate)
        .then_some(())
        .ok_or_else(|| "候选问题记录无效或超过安全边界".to_string())
}

pub fn validate_finding_validation(
    candidate: &FindingCandidate,
    validation: &FindingValidation,
) -> Result<(), String> {
    if candidate.candidate_id != validation.candidate_id {
        return Err("候选问题与验证记录 ID 不匹配".to_string());
    }
    valid_validation(candidate, validation)
        .then_some(())
        .ok_or_else(|| "候选问题验证记录无效或超过安全边界".to_string())
}

pub fn validate_finding_replay_contract(contract: &FindingReplayContract) -> Result<(), String> {
    let valid = contract.schema_version == FINDING_REPLAY_CONTRACT_SCHEMA_VERSION
        && valid_id(&contract.candidate_id)
        && valid_id(&contract.original_validator_task_id)
        && valid_id(&contract.repair_task_id)
        && valid_id(&contract.replay_task_id)
        && valid_id(&contract.reviewer_task_id)
        && valid_relative_path(&contract.location.path)
        && valid_text(&contract.input_summary, MAX_SUMMARY_CHARS, false)
        && valid_text(&contract.command, MAX_COMMAND_CHARS, false)
        && valid_path_text(&contract.working_directory)
        && contract.created_at >= contract.original_validated_at;
    valid
        .then_some(())
        .ok_or_else(|| "问题重放合同无效或超过安全边界".to_string())
}

pub fn validate_finding_replay_review(review: &FindingReplayReview) -> Result<(), String> {
    let valid = review.schema_version == FINDING_REPLAY_REVIEW_SCHEMA_VERSION
        && valid_id(&review.candidate_id)
        && valid_id(&review.replay_task_id)
        && valid_id(&review.reviewer_task_id)
        && valid_text(&review.summary, MAX_SUMMARY_CHARS, false);
    valid
        .then_some(())
        .ok_or_else(|| "问题重放审查记录无效或超过安全边界".to_string())
}

fn classify_confirmed(
    candidate: &FindingCandidate,
    validation: &FindingValidation,
) -> FindingValidationDecision {
    if candidate.location.is_none() {
        return unverified(FindingValidationDecisionReason::MissingLocation);
    }
    if candidate
        .contract_reference
        .as_deref()
        .is_none_or(|contract| contract.trim().is_empty())
    {
        return unverified(FindingValidationDecisionReason::MissingContract);
    }
    if validation
        .evidence
        .as_ref()
        .is_none_or(|evidence| evidence.exit_code.is_none())
    {
        return unverified(FindingValidationDecisionReason::MissingHostEvidence);
    }
    if validation.input_summary.trim().is_empty() {
        return unverified(FindingValidationDecisionReason::MissingInputSummary);
    }
    if validation.output_summary.trim().is_empty() {
        return unverified(FindingValidationDecisionReason::MissingOutputSummary);
    }
    FindingValidationDecision {
        kind: FindingKind::ConfirmedBug,
        confirmed: true,
        reason: FindingValidationDecisionReason::Confirmed,
    }
}

fn unverified(reason: FindingValidationDecisionReason) -> FindingValidationDecision {
    FindingValidationDecision {
        kind: FindingKind::UnverifiedScenario,
        confirmed: false,
        reason,
    }
}

fn valid_candidate(candidate: &FindingCandidate) -> bool {
    candidate.schema_version == FINDING_CANDIDATE_SCHEMA_VERSION
        && valid_id(&candidate.candidate_id)
        && valid_id(&candidate.run_id)
        && valid_id(&candidate.task_id)
        && valid_single_line(&candidate.title, MAX_TITLE_CHARS)
        && valid_single_line(&candidate.severity, MAX_SEVERITY_CHARS)
        && candidate
            .location
            .as_ref()
            .is_none_or(|location| valid_relative_path(&location.path))
        && valid_text(&candidate.observed_behavior, MAX_DETAIL_CHARS, false)
        && candidate
            .contract_reference
            .as_deref()
            .is_none_or(|value| valid_text(value, MAX_DETAIL_CHARS, true))
        && valid_text(&candidate.impact, MAX_DETAIL_CHARS, false)
        && candidate
            .validation_hint
            .as_deref()
            .is_none_or(|value| valid_text(value, MAX_DETAIL_CHARS, true))
}

fn valid_validation(candidate: &FindingCandidate, validation: &FindingValidation) -> bool {
    validation.schema_version == FINDING_VALIDATION_SCHEMA_VERSION
        && valid_id(&validation.candidate_id)
        && valid_id(&validation.validator_task_id)
        && valid_text(&validation.input_summary, MAX_SUMMARY_CHARS, true)
        && valid_text(&validation.output_summary, MAX_SUMMARY_CHARS, true)
        && validation.missing_evidence.len() <= MAX_MISSING_EVIDENCE
        && validation
            .missing_evidence
            .iter()
            .all(|value| valid_text(value, MAX_MISSING_EVIDENCE_CHARS, false))
        && validation
            .evidence
            .as_ref()
            .is_none_or(valid_verification_evidence)
        && validation.validated_at >= candidate.created_at
}

fn valid_verification_evidence(evidence: &VerificationEvidence) -> bool {
    valid_text(&evidence.command, MAX_COMMAND_CHARS, false)
        && valid_path_text(&evidence.working_directory)
        && evidence
            .stdout_artifact
            .as_deref()
            .is_none_or(valid_relative_path)
        && evidence
            .stderr_artifact
            .as_deref()
            .is_none_or(valid_relative_path)
        && evidence.finished_at >= evidence.started_at
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_RECORD_ID_CHARS
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
}

fn valid_single_line(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn valid_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_path_text(path: &Path) -> bool {
    let value = path.to_string_lossy();
    !value.trim().is_empty()
        && value.chars().count() <= MAX_PATH_CHARS
        && !value.chars().any(char::is_control)
}

fn valid_relative_path(path: &Path) -> bool {
    valid_path_text(path)
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingRecord {
    pub schema_version: u8,
    pub finding_id: String,
    pub fingerprint: String,
    pub kind: FindingKind,
    pub severity: String,
    pub confidence: String,
    pub lifecycle: FindingLifecycle,
    pub title: String,
    pub location: Option<SourceLocation>,
    pub impact: String,
    pub reproduction: Option<VerificationEvidence>,
    pub validation_status: String,
    pub remediation: Option<String>,
    pub first_seen_run: String,
    pub last_seen_run: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverageRecord {
    pub schema_version: u8,
    pub run_id: String,
    pub requested_scope: Vec<PathBuf>,
    pub reviewed_scope: Vec<PathBuf>,
    pub exclusions: Vec<String>,
    pub deferred_checks: Vec<String>,
    pub completeness: String,
}
