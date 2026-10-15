use goose::agents::codepro_review::{
    can_report_no_findings, terminal_state_after_restart, Finding, ReviewCoverage, ReviewFreshness,
    ReviewStatus,
};

#[test]
fn only_complete_current_success_can_report_no_findings() {
    for status in [
        ReviewStatus::Running,
        ReviewStatus::Completed,
        ReviewStatus::Failed,
        ReviewStatus::Cancelled,
        ReviewStatus::Interrupted,
        ReviewStatus::NoChanges,
        ReviewStatus::NoReviewableContent,
    ] {
        for coverage in [ReviewCoverage::Complete, ReviewCoverage::Partial] {
            for freshness in [
                ReviewFreshness::Current,
                ReviewFreshness::Stale,
                ReviewFreshness::Unknown,
            ] {
                for count in [0, 1] {
                    assert_eq!(
                        can_report_no_findings(status, coverage, freshness, count),
                        status == ReviewStatus::Completed
                            && coverage == ReviewCoverage::Complete
                            && freshness == ReviewFreshness::Current
                            && count == 0
                    );
                }
            }
        }
    }
}

#[test]
fn restart_interrupts_work_without_changing_terminal_outcomes() {
    assert_eq!(
        terminal_state_after_restart(ReviewStatus::Running),
        ReviewStatus::Interrupted
    );
    for status in [
        ReviewStatus::Completed,
        ReviewStatus::Failed,
        ReviewStatus::Cancelled,
        ReviewStatus::Interrupted,
        ReviewStatus::NoChanges,
        ReviewStatus::NoReviewableContent,
    ] {
        assert_eq!(terminal_state_after_restart(status), status);
    }
}

#[test]
fn wire_contract_rejects_unknown_fields_and_unknown_statuses() {
    let mut finding = serde_json::json!({
        "id": "finding-1", "priority": 1, "title": "Title", "body": "Body",
        "path": "file.rs", "side": "new", "startLine": 1, "endLine": 1
    });
    assert!(serde_json::from_value::<Finding>(finding.clone()).is_ok());
    finding["toolCall"] = serde_json::json!({"name": "shell"});
    assert!(serde_json::from_value::<Finding>(finding).is_err());
    assert!(serde_json::from_str::<ReviewStatus>("\"success\"").is_err());
    assert_eq!(
        serde_json::to_string(&ReviewStatus::NoReviewableContent).unwrap(),
        "\"no_reviewable_content\""
    );
}
