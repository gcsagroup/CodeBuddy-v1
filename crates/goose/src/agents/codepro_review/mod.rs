mod git;
mod runner;
mod snapshot;
mod store;

pub use runner::{ReviewRunner, ReviewStartRequest, ReviewTestEvidence};
pub use snapshot::{capture_snapshot, SnapshotRequest};

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const REVIEW_SCHEMA_VERSION: u16 = 1;
pub const MAX_REVIEW_FILES: usize = 200;
pub const MAX_REVIEW_FILE_BYTES: usize = 64 * 1024;
pub const MAX_REVIEW_CONTENT_BYTES: usize = 256 * 1024;
pub const MAX_REVIEW_FINDINGS: usize = 200;

pub(crate) async fn delete_stored_review_session(data_root: &Path, session_id: &str) -> Result<()> {
    store::ReviewStore::open(data_root)?
        .delete_session(session_id)
        .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    NoChanges,
    NoReviewableContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewCoverage {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewScope {
    WorkingTree,
    Staged,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSide {
    Old,
    New,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewModel {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewHunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub old_text: String,
    pub new_text: String,
    pub old_hash: String,
    pub new_hash: String,
    pub diff: String,
    pub hunks: Vec<ReviewHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewExclusionReason {
    SensitivePath,
    NonRegularFile,
    BinaryOrNonUtf8,
    FileTooLarge,
    ContentLimit,
    FileLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewExclusion {
    pub path: String,
    pub reason: ReviewExclusionReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSnapshot {
    pub schema_version: u16,
    pub snapshot_id: String,
    pub session_id: String,
    pub scope: ReviewScope,
    pub base_ref: Option<String>,
    pub head_oid: Option<String>,
    pub base_oid: Option<String>,
    pub model: ReviewModel,
    pub files: Vec<ReviewFile>,
    pub coverage: ReviewCoverage,
    pub excluded_files: Vec<ReviewExclusion>,
    pub fingerprint: String,
    pub captured_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    pub id: String,
    pub priority: u8,
    pub title: String,
    pub body: String,
    pub path: String,
    pub side: ReviewSide,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceMatch {
    Matching,
    Unverified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewTestEvidenceRef {
    pub id: String,
    pub version_match: ReviewEvidenceMatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewResult {
    pub schema_version: u16,
    pub review_id: String,
    pub snapshot_id: String,
    pub revision: u64,
    pub status: ReviewStatus,
    pub freshness: ReviewFreshness,
    pub coverage: ReviewCoverage,
    pub findings: Vec<Finding>,
    pub excluded_files: Vec<ReviewExclusion>,
    pub test_evidence_refs: Vec<ReviewTestEvidenceRef>,
    pub error: Option<ReviewError>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn can_report_no_findings(
    status: ReviewStatus,
    coverage: ReviewCoverage,
    freshness: ReviewFreshness,
    finding_count: usize,
) -> bool {
    status == ReviewStatus::Completed
        && coverage == ReviewCoverage::Complete
        && freshness == ReviewFreshness::Current
        && finding_count == 0
}

pub fn terminal_state_after_restart(status: ReviewStatus) -> ReviewStatus {
    match status {
        ReviewStatus::Running => ReviewStatus::Interrupted,
        terminal => terminal,
    }
}

pub fn validate_finding_location(finding: &Finding, snapshot: &ReviewSnapshot) -> Result<()> {
    ensure!(
        snapshot.schema_version == REVIEW_SCHEMA_VERSION,
        "unsupported_review_schema"
    );
    ensure!(
        finding.priority <= 3
            && !finding.id.trim().is_empty()
            && finding.id.len() <= 128
            && !finding.title.trim().is_empty()
            && finding.title.len() <= 512
            && !finding.body.trim().is_empty()
            && finding.body.len() <= 8192,
        "invalid_review_finding"
    );
    ensure!(
        finding.start_line > 0 && finding.end_line >= finding.start_line,
        "invalid_review_line"
    );
    let file = snapshot
        .files
        .iter()
        .find(|file| match finding.side {
            ReviewSide::New => file.path == finding.path,
            ReviewSide::Old => file.original_path.as_ref().unwrap_or(&file.path) == &finding.path,
        })
        .ok_or_else(|| anyhow::anyhow!("review_path_not_in_snapshot"))?;
    ensure!(
        file.hunks.iter().any(|hunk| {
            let (start, count) = match finding.side {
                ReviewSide::Old => (hunk.old_start, hunk.old_count),
                ReviewSide::New => (hunk.new_start, hunk.new_count),
            };
            count > 0
                && finding.start_line >= start
                && u64::from(finding.end_line) < u64::from(start) + u64::from(count)
        }),
        "review_line_not_in_hunk"
    );
    Ok(())
}
