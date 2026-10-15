use chrono::{DateTime, Utc};
use goose::agents::{
    CoverageRecord, FindingKind, FindingLifecycle, FindingRecord, SourceLocation,
    VerificationEvidence, COVERAGE_RECORD_SCHEMA_VERSION, FINDING_RECORD_SCHEMA_VERSION,
};
use serde_json::json;
use std::path::PathBuf;

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

fn verification_evidence() -> VerificationEvidence {
    VerificationEvidence {
        command: ".venv/Scripts/python.exe -m pytest tests/test_api.py -q".to_string(),
        working_directory: PathBuf::from("project"),
        exit_code: Some(1),
        passed: 4,
        failed: 1,
        skipped: 0,
        stdout_artifact: Some(PathBuf::from("artifacts/pytest.stdout.txt")),
        stderr_artifact: None,
        started_at: timestamp("2026-07-31T01:00:00Z"),
        finished_at: timestamp("2026-07-31T01:00:03Z"),
    }
}

fn finding_record() -> FindingRecord {
    FindingRecord {
        schema_version: FINDING_RECORD_SCHEMA_VERSION,
        finding_id: "BUG-001".to_string(),
        fingerprint: "sha256:root-cause-location-rule".to_string(),
        kind: FindingKind::ConfirmedBug,
        severity: "high".to_string(),
        confidence: "verified".to_string(),
        lifecycle: FindingLifecycle::New,
        title: "API 返回值违反公开类型合同".to_string(),
        location: Some(SourceLocation {
            path: PathBuf::from("src/api.rs"),
            line: Some(42),
            column: Some(9),
        }),
        impact: "调用方会收到无法解析的响应".to_string(),
        reproduction: Some(verification_evidence()),
        validation_status: "reproduced".to_string(),
        remediation: Some("按公开类型合同返回 Result".to_string()),
        first_seen_run: "run-001".to_string(),
        last_seen_run: "run-001".to_string(),
    }
}

#[test]
fn finding_record_v1_has_a_stable_wire_format() {
    let value = serde_json::to_value(finding_record()).unwrap();

    assert_eq!(
        value,
        json!({
            "schema_version": 1,
            "finding_id": "BUG-001",
            "fingerprint": "sha256:root-cause-location-rule",
            "kind": "confirmed_bug",
            "severity": "high",
            "confidence": "verified",
            "lifecycle": "new",
            "title": "API 返回值违反公开类型合同",
            "location": {
                "path": "src/api.rs",
                "line": 42,
                "column": 9
            },
            "impact": "调用方会收到无法解析的响应",
            "reproduction": {
                "command": ".venv/Scripts/python.exe -m pytest tests/test_api.py -q",
                "working_directory": "project",
                "exit_code": 1,
                "passed": 4,
                "failed": 1,
                "skipped": 0,
                "stdout_artifact": "artifacts/pytest.stdout.txt",
                "stderr_artifact": null,
                "started_at": "2026-07-31T01:00:00Z",
                "finished_at": "2026-07-31T01:00:03Z"
            },
            "validation_status": "reproduced",
            "remediation": "按公开类型合同返回 Result",
            "first_seen_run": "run-001",
            "last_seen_run": "run-001"
        })
    );
}

#[test]
fn coverage_record_v1_round_trips_without_losing_scope() {
    let record = CoverageRecord {
        schema_version: COVERAGE_RECORD_SCHEMA_VERSION,
        run_id: "run-001".to_string(),
        requested_scope: vec![PathBuf::from("src"), PathBuf::from("tests")],
        reviewed_scope: vec![PathBuf::from("src/api.rs")],
        exclusions: vec!["target/**：生成目录".to_string()],
        deferred_checks: vec!["真实 Provider：缺少密钥".to_string()],
        completeness: "partial".to_string(),
    };

    let value = serde_json::to_value(&record).unwrap();
    let restored: CoverageRecord = serde_json::from_value(value.clone()).unwrap();

    assert_eq!(restored, record);
    assert_eq!(
        value,
        json!({
            "schema_version": 1,
            "run_id": "run-001",
            "requested_scope": ["src", "tests"],
            "reviewed_scope": ["src/api.rs"],
            "exclusions": ["target/**：生成目录"],
            "deferred_checks": ["真实 Provider：缺少密钥"],
            "completeness": "partial"
        })
    );
}

#[test]
fn unknown_future_finding_enums_degrade_without_rejecting_the_record() {
    let mut value = serde_json::to_value(finding_record()).unwrap();
    value["kind"] = json!("future_finding_kind");
    value["lifecycle"] = json!("future_lifecycle");

    let record: FindingRecord = serde_json::from_value(value).unwrap();

    assert_eq!(record.kind, FindingKind::Unknown);
    assert_eq!(record.lifecycle, FindingLifecycle::Unknown);
}

#[test]
fn schema_version_is_required_for_both_records() {
    let mut finding = serde_json::to_value(finding_record()).unwrap();
    finding.as_object_mut().unwrap().remove("schema_version");
    assert!(serde_json::from_value::<FindingRecord>(finding).is_err());

    let coverage = json!({
        "run_id": "run-001",
        "requested_scope": [],
        "reviewed_scope": [],
        "exclusions": [],
        "deferred_checks": [],
        "completeness": "complete"
    });
    assert!(serde_json::from_value::<CoverageRecord>(coverage).is_err());
}
