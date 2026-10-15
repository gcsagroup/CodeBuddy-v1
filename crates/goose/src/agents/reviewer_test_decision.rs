use crate::agents::agent_role::CodeProRiskTier;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewerTestLevel {
    NotRequired,
    StaticOnly,
    AutomatedTests,
    DesktopSmoke,
    FullUserFlow,
    WaitingForEnvOrPermission,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewerTestDecisionInput {
    pub changed_files: Vec<String>,
    pub risk_tier: CodeProRiskTier,
    pub user_requires_real_desktop: bool,
    pub historical_path_regression: bool,
    pub prior_outcome_unknown: bool,
    pub executable_artifact_available: bool,
    pub desktop_environment_available: bool,
    pub permission_available: bool,
    pub current_artifact_sha256: Option<String>,
    pub accepted_artifact_sha256: Option<String>,
    pub acceptance_environment_fingerprint: Option<String>,
    pub current_environment_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewerTestDecision {
    pub decision: ReviewerTestLevel,
    pub reason: String,
    pub required_evidence: Vec<String>,
    pub selected_tests: Vec<String>,
    pub reused_evidence: bool,
}

pub fn decide_reviewer_tests(input: &ReviewerTestDecisionInput) -> ReviewerTestDecision {
    let changed = input
        .changed_files
        .iter()
        .map(|path| path.replace('\\', "/").to_ascii_lowercase())
        .collect::<Vec<_>>();
    let documentation_only = !changed.is_empty()
        && changed.iter().all(|path| {
            path.starts_with("documentation/")
                || path.starts_with("docs/")
                || path.ends_with(".md")
                || path.ends_with(".txt")
        });
    if documentation_only && !input.user_requires_real_desktop {
        return decision(
            ReviewerTestLevel::NotRequired,
            "Only documentation or translation artifacts changed.",
            &["reviewed_diff"],
            &[],
            false,
        );
    }

    let same_artifact = input.current_artifact_sha256.is_some()
        && input.current_artifact_sha256 == input.accepted_artifact_sha256;
    let same_environment = input.current_environment_fingerprint.is_some()
        && input.current_environment_fingerprint == input.acceptance_environment_fingerprint;
    if same_artifact
        && same_environment
        && !input.user_requires_real_desktop
        && !input.historical_path_regression
        && !input.prior_outcome_unknown
    {
        return decision(
            ReviewerTestLevel::NotRequired,
            "A still-valid acceptance receipt covers the identical artifact and environment.",
            &[
                "reused_acceptance_receipt",
                "artifact_sha256",
                "environment_fingerprint",
            ],
            &[],
            true,
        );
    }

    let ui_or_desktop = changed.iter().any(|path| {
        path.starts_with("ui/")
            || path.contains("computer")
            || path.contains("window")
            || path.contains("permission")
            || path.contains("workspace_lease")
            || path.contains("installer")
            || path.contains("updater")
    });
    let full_flow_required = input.user_requires_real_desktop
        || input.historical_path_regression
        || input.prior_outcome_unknown
        || input.risk_tier == CodeProRiskTier::L3HighRiskRelease
        || changed.iter().any(|path| {
            path.contains("computer")
                || path.contains("installer")
                || path.contains("updater")
                || path.contains("permission")
                || path.contains("workspace_lease")
        });
    let desktop_required = full_flow_required || ui_or_desktop;
    if desktop_required
        && (!input.executable_artifact_available
            || !input.desktop_environment_available
            || !input.permission_available)
    {
        return decision(
            ReviewerTestLevel::WaitingForEnvOrPermission,
            "Desktop acceptance is required, but its artifact, environment, or permission is unavailable; resume this decision from the saved checkpoint.",
            &["checkpoint", "missing_prerequisite", "resume_token"],
            &[],
            false,
        );
    }
    if full_flow_required {
        return decision(
            ReviewerTestLevel::FullUserFlow,
            "Risk, explicit user intent, prior regression, or an unknown outcome requires an end-to-end user-visible result.",
            &["step_receipts", "before_after_screenshots", "ui_state_diff", "final_postcondition"],
            &["automated_regression", "full_user_flow"],
            false,
        );
    }
    if ui_or_desktop {
        return decision(
            ReviewerTestLevel::DesktopSmoke,
            "The change affects a visible UI or interaction path, so automated checks need a shortest sufficient desktop smoke test.",
            &["automated_test_receipt", "desktop_step_receipt", "visible_postcondition"],
            &["automated_regression", "desktop_smoke"],
            false,
        );
    }
    if !input.executable_artifact_available {
        return decision(
            ReviewerTestLevel::StaticOnly,
            "No executable artifact exists and the change does not require desktop proof.",
            &["reviewed_diff", "artifact_absence"],
            &[],
            false,
        );
    }
    decision(
        ReviewerTestLevel::AutomatedTests,
        "The change is executable backend logic whose user-visible behavior is sufficiently covered by focused automation.",
        &["command", "cwd", "exit_code", "test_counts", "artifact_sha256"],
        &["focused_automated_tests"],
        false,
    )
}

fn decision(
    level: ReviewerTestLevel,
    reason: &str,
    required_evidence: &[&str],
    selected_tests: &[&str],
    reused_evidence: bool,
) -> ReviewerTestDecision {
    ReviewerTestDecision {
        decision: level,
        reason: reason.to_string(),
        required_evidence: required_evidence
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        selected_tests: selected_tests
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        reused_evidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(files: &[&str]) -> ReviewerTestDecisionInput {
        ReviewerTestDecisionInput {
            changed_files: files.iter().map(|path| (*path).to_string()).collect(),
            risk_tier: CodeProRiskTier::L1ReversibleChange,
            user_requires_real_desktop: false,
            historical_path_regression: false,
            prior_outcome_unknown: false,
            executable_artifact_available: true,
            desktop_environment_available: true,
            permission_available: true,
            current_artifact_sha256: Some("new".into()),
            accepted_artifact_sha256: Some("old".into()),
            acceptance_environment_fingerprint: Some("windows-test-user".into()),
            current_environment_fingerprint: Some("windows-test-user".into()),
        }
    }

    #[test]
    fn identical_input_is_stable() {
        let input = input(&["crates/goose/src/lib.rs"]);
        assert_eq!(decide_reviewer_tests(&input), decide_reviewer_tests(&input));
    }

    #[test]
    fn selects_level_from_change_and_evidence_risk() {
        assert_eq!(
            decide_reviewer_tests(&input(&["ui/desktop/src/App.tsx"])).decision,
            ReviewerTestLevel::DesktopSmoke
        );
        assert_eq!(
            decide_reviewer_tests(&input(&["crates/goose/src/pure_logic.rs"])).decision,
            ReviewerTestLevel::AutomatedTests
        );
        assert_eq!(
            decide_reviewer_tests(&input(&["documentation/guide.md"])).decision,
            ReviewerTestLevel::NotRequired
        );
    }

    #[test]
    fn required_desktop_never_downgrades_when_environment_is_missing() {
        let mut input = input(&["ui/desktop/src/App.tsx"]);
        input.desktop_environment_available = false;
        assert_eq!(
            decide_reviewer_tests(&input).decision,
            ReviewerTestLevel::WaitingForEnvOrPermission
        );
        input.desktop_environment_available = true;
        input.user_requires_real_desktop = true;
        assert_eq!(
            decide_reviewer_tests(&input).decision,
            ReviewerTestLevel::FullUserFlow
        );
    }

    #[test]
    fn valid_identical_artifact_receipt_is_reused_but_unknown_escalates() {
        let mut input = input(&["crates/goose/src/pure_logic.rs"]);
        input.current_artifact_sha256 = Some("same".into());
        input.accepted_artifact_sha256 = Some("same".into());
        let reused = decide_reviewer_tests(&input);
        assert_eq!(reused.decision, ReviewerTestLevel::NotRequired);
        assert!(reused.reused_evidence);
        input.prior_outcome_unknown = true;
        assert_eq!(
            decide_reviewer_tests(&input).decision,
            ReviewerTestLevel::FullUserFlow
        );
    }
}
