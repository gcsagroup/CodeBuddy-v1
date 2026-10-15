use goose::agents::{
    compare_finding_runs, false_positive_still_applies, generate_finding_fingerprint,
    select_finding_reruns, FindingCheckDefinition, FindingComparisonCoverage, FindingFalsePositive,
    FindingFingerprintInput, FindingLifecycle, FindingRerunInput, FindingRunSnapshot,
    ResultAggregator, SourceLocation, TaskDAG, FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
    FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION, FINDING_FALSE_POSITIVE_SCHEMA_VERSION,
    FINDING_FINGERPRINT_INPUT_SCHEMA_VERSION, FINDING_RERUN_INPUT_SCHEMA_VERSION,
    FINDING_RUN_SNAPSHOT_SCHEMA_VERSION,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn input() -> FindingFingerprintInput {
    FindingFingerprintInput {
        schema_version: FINDING_FINGERPRINT_INPUT_SCHEMA_VERSION,
        root_cause: "响应对象没有经过 Result 包装".to_string(),
        rule: "public-api:return-result".to_string(),
        location: SourceLocation {
            path: PathBuf::from("src/api.rs"),
            line: Some(42),
            column: Some(9),
        },
        data_flow: vec!["handler return".to_string(), "public response".to_string()],
    }
}

#[test]
fn fingerprint_input_v1_has_a_stable_wire_format() {
    assert_eq!(
        serde_json::to_value(input()).unwrap(),
        json!({
            "schema_version": 1,
            "root_cause": "响应对象没有经过 Result 包装",
            "rule": "public-api:return-result",
            "location": { "path": "src/api.rs", "line": 42, "column": 9 },
            "data_flow": ["handler return", "public response"]
        })
    );
    assert_eq!(
        generate_finding_fingerprint(&input()).unwrap(),
        "b3:v1:7df2266d183d5be06b3f57e16daec8546b03ccadb1c5ff753ded392e7a77184b"
    );
}

#[test]
fn line_movement_and_equivalent_text_or_windows_paths_keep_the_same_identity() {
    let expected = generate_finding_fingerprint(&input()).unwrap();

    let mut moved = input();
    moved.location.line = Some(420);
    moved.location.column = Some(1);
    moved.location.path = PathBuf::from(r"SRC\API.rs");
    moved.root_cause = "  响应对象没有经过   Result 包装  ".to_string();
    moved.data_flow = vec![
        "handler\u{00a0}return".to_string(),
        "public response".to_string(),
    ];

    assert_eq!(generate_finding_fingerprint(&moved).unwrap(), expected);
}

#[test]
fn every_semantic_identity_component_changes_the_fingerprint() {
    let original = generate_finding_fingerprint(&input()).unwrap();
    let mut variants = Vec::new();

    let mut root_cause = input();
    root_cause.root_cause = "响应对象被错误缓存".to_string();
    variants.push(root_cause);

    let mut rule = input();
    rule.rule = "public-api:return-option".to_string();
    variants.push(rule);

    let mut location = input();
    location.location.path = PathBuf::from("src/other.rs");
    variants.push(location);

    let mut flow = input();
    flow.data_flow.swap(0, 1);
    variants.push(flow);

    for variant in variants {
        assert_ne!(generate_finding_fingerprint(&variant).unwrap(), original);
    }
}

#[test]
fn unsafe_empty_or_unbounded_fingerprint_inputs_are_rejected() {
    let mut traversal = input();
    traversal.location.path = PathBuf::from("../secret.rs");
    assert!(generate_finding_fingerprint(&traversal).is_err());

    let mut empty = input();
    empty.root_cause.clear();
    assert!(generate_finding_fingerprint(&empty).is_err());

    let mut too_many_nodes = input();
    too_many_nodes.data_flow = vec!["node".to_string(); 65];
    assert!(generate_finding_fingerprint(&too_many_nodes).is_err());

    let mut oversized = input();
    oversized.rule = "x".repeat(2_001);
    assert!(generate_finding_fingerprint(&oversized).is_err());
}

fn snapshot(
    fingerprint: &str,
    run_id: &str,
    lifecycle: FindingLifecycle,
    path: &str,
) -> FindingRunSnapshot {
    FindingRunSnapshot {
        schema_version: FINDING_RUN_SNAPSHOT_SCHEMA_VERSION,
        fingerprint: fingerprint.to_string(),
        run_id: run_id.to_string(),
        lifecycle,
        location: SourceLocation {
            path: PathBuf::from(path),
            line: Some(10),
            column: None,
        },
        validation_complete: true,
    }
}

#[test]
fn cross_run_comparison_classifies_all_lifecycles_and_deduplicates() {
    let persistent = generate_finding_fingerprint(&input()).unwrap();
    let mut reopened_input = input();
    reopened_input.root_cause = "重新出现".to_string();
    let reopened = generate_finding_fingerprint(&reopened_input).unwrap();
    let mut resolved_input = input();
    resolved_input.root_cause = "已经解决".to_string();
    let resolved = generate_finding_fingerprint(&resolved_input).unwrap();
    let mut unknown_input = input();
    unknown_input.root_cause = "覆盖不足".to_string();
    let unknown = generate_finding_fingerprint(&unknown_input).unwrap();
    let mut new_input = input();
    new_input.root_cause = "本轮新增".to_string();
    let new_finding = generate_finding_fingerprint(&new_input).unwrap();

    let previous = vec![
        snapshot(&persistent, "run-1", FindingLifecycle::New, "src/api.rs"),
        snapshot(
            &reopened,
            "run-1",
            FindingLifecycle::Resolved,
            "src/reopened.rs",
        ),
        snapshot(
            &resolved,
            "run-1",
            FindingLifecycle::Persisting,
            "src/resolved.rs",
        ),
        snapshot(
            &unknown,
            "run-1",
            FindingLifecycle::Persisting,
            "src/not-reviewed.rs",
        ),
    ];
    let current = vec![
        snapshot(&persistent, "run-2", FindingLifecycle::New, "src/api.rs"),
        snapshot(&persistent, "run-2", FindingLifecycle::New, "src/api.rs"),
        snapshot(&reopened, "run-2", FindingLifecycle::New, "src/reopened.rs"),
        snapshot(&new_finding, "run-2", FindingLifecycle::New, "src/new.rs"),
    ];
    let coverage = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![
            PathBuf::from("src/api.rs"),
            PathBuf::from("src/reopened.rs"),
            PathBuf::from("src/resolved.rs"),
            PathBuf::from("src/new.rs"),
        ],
        coverage_complete: true,
        artifacts_complete: true,
    };

    let comparisons = compare_finding_runs(&previous, &current, &coverage).unwrap();
    assert_eq!(comparisons.len(), 5);
    let lifecycle = |fingerprint: &str| {
        comparisons
            .iter()
            .find(|comparison| comparison.fingerprint == fingerprint)
            .unwrap()
            .lifecycle
    };
    assert_eq!(lifecycle(&persistent), FindingLifecycle::Persisting);
    assert_eq!(lifecycle(&reopened), FindingLifecycle::Reopened);
    assert_eq!(lifecycle(&resolved), FindingLifecycle::Resolved);
    assert_eq!(lifecycle(&unknown), FindingLifecycle::Unknown);
    assert_eq!(lifecycle(&new_finding), FindingLifecycle::New);
}

#[test]
fn incomplete_current_validation_is_unknown_instead_of_new_or_persisting() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let previous = vec![snapshot(
        &fingerprint,
        "run-1",
        FindingLifecycle::New,
        "src/api.rs",
    )];
    let mut current = snapshot(&fingerprint, "run-2", FindingLifecycle::New, "src/api.rs");
    current.validation_complete = false;
    let coverage = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![PathBuf::from("src/api.rs")],
        coverage_complete: true,
        artifacts_complete: true,
    };

    let result = compare_finding_runs(&previous, &[current], &coverage).unwrap();
    assert_eq!(result[0].lifecycle, FindingLifecycle::Unknown);
}

#[test]
fn comparison_contracts_have_stable_v1_wire_formats() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let current = snapshot(&fingerprint, "run-2", FindingLifecycle::New, "src/api.rs");
    let coverage = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![PathBuf::from("src/api.rs")],
        coverage_complete: true,
        artifacts_complete: true,
    };
    let comparison = compare_finding_runs(&[], std::slice::from_ref(&current), &coverage)
        .unwrap()
        .remove(0);

    assert_eq!(
        serde_json::to_value(current).unwrap(),
        json!({
            "schema_version": 1,
            "fingerprint": fingerprint,
            "run_id": "run-2",
            "lifecycle": "new",
            "location": { "path": "src/api.rs", "line": 10, "column": null },
            "validation_complete": true
        })
    );
    assert_eq!(
        serde_json::to_value(coverage).unwrap(),
        json!({
            "schema_version": 1,
            "run_id": "run-2",
            "reviewed_scope": ["src/api.rs"],
            "coverage_complete": true,
            "artifacts_complete": true
        })
    );
    assert_eq!(
        serde_json::to_value(comparison).unwrap(),
        json!({
            "schema_version": 1,
            "fingerprint": fingerprint,
            "lifecycle": "new",
            "location": { "path": "src/api.rs", "line": 10, "column": null },
            "previous_run": null,
            "current_run": "run-2",
            "reason": "当前运行首次出现"
        })
    );
}

#[test]
fn missing_finding_is_resolved_only_with_complete_exact_coverage_and_artifacts() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let previous = vec![snapshot(
        &fingerprint,
        "run-1",
        FindingLifecycle::Persisting,
        "src/api.rs",
    )];
    let base = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![PathBuf::from(r"SRC\API.rs")],
        coverage_complete: true,
        artifacts_complete: true,
    };
    let lifecycle = |coverage: &FindingComparisonCoverage| {
        compare_finding_runs(&previous, &[], coverage).unwrap()[0].lifecycle
    };

    assert_eq!(lifecycle(&base), FindingLifecycle::Resolved);
    let mut uncovered = base.clone();
    uncovered.reviewed_scope.clear();
    assert_eq!(lifecycle(&uncovered), FindingLifecycle::Unknown);
    let mut incomplete_coverage = base.clone();
    incomplete_coverage.coverage_complete = false;
    assert_eq!(lifecycle(&incomplete_coverage), FindingLifecycle::Unknown);
    let mut missing_artifact = base;
    missing_artifact.artifacts_complete = false;
    assert_eq!(lifecycle(&missing_artifact), FindingLifecycle::Unknown);
}

#[test]
fn malformed_snapshots_coverage_and_noncanonical_fingerprints_are_rejected() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let uppercase_hex = format!(
        "b3:v1:{}",
        fingerprint
            .trim_start_matches("b3:v1:")
            .to_ascii_uppercase()
    );
    let mut invalid_snapshot =
        snapshot(&uppercase_hex, "run-1", FindingLifecycle::New, "src/api.rs");
    let coverage = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![PathBuf::from("src/api.rs")],
        coverage_complete: true,
        artifacts_complete: true,
    };
    assert!(compare_finding_runs(&[invalid_snapshot.clone()], &[], &coverage).is_err());

    invalid_snapshot.fingerprint = fingerprint.clone();
    invalid_snapshot.location.path = PathBuf::from("../secret.rs");
    assert!(compare_finding_runs(&[invalid_snapshot], &[], &coverage).is_err());

    let mut unsafe_coverage = coverage.clone();
    unsafe_coverage.reviewed_scope = vec![PathBuf::from("../src/api.rs")];
    assert!(compare_finding_runs(
        &[snapshot(
            &fingerprint,
            "run-1",
            FindingLifecycle::New,
            "src/api.rs"
        )],
        &[],
        &unsafe_coverage
    )
    .is_err());

    let current = snapshot(
        &fingerprint,
        "different-run",
        FindingLifecycle::New,
        "src/api.rs",
    );
    assert!(compare_finding_runs(&[], &[current], &coverage).is_err());
}

#[test]
fn false_positive_is_reused_only_when_reason_and_conditions_still_match() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let conditions = BTreeMap::from([
        ("platform".to_string(), "windows".to_string()),
        ("feature".to_string(), "legacy-api".to_string()),
    ]);
    let record = FindingFalsePositive {
        schema_version: FINDING_FALSE_POSITIVE_SCHEMA_VERSION,
        fingerprint: fingerprint.clone(),
        reason: "该分支仅在已停用的兼容模式可达".to_string(),
        applicability: conditions.clone(),
        recorded_run: "run-1".to_string(),
    };

    assert!(false_positive_still_applies(
        &record,
        &fingerprint,
        "该分支仅在已停用的兼容模式可达",
        &conditions
    )
    .unwrap());
    assert!(
        !false_positive_still_applies(&record, &fingerprint, "原因已经变化", &conditions).unwrap()
    );
    let mut changed = conditions;
    changed.insert("feature".to_string(), "new-api".to_string());
    assert!(!false_positive_still_applies(
        &record,
        &fingerprint,
        "该分支仅在已停用的兼容模式可达",
        &changed
    )
    .unwrap());
}

#[test]
fn rerun_plan_selects_failed_or_directly_affected_checks_once() {
    let failed = generate_finding_fingerprint(&input()).unwrap();
    let input = FindingRerunInput {
        schema_version: FINDING_RERUN_INPUT_SCHEMA_VERSION,
        failed_fingerprints: vec![failed.clone(), failed.clone()],
        modified_paths: vec![PathBuf::from("src/api.rs")],
        checks: vec![
            FindingCheckDefinition {
                schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
                check_id: "check-api".to_string(),
                related_fingerprints: vec![],
                watched_paths: vec![PathBuf::from("src/api.rs")],
            },
            FindingCheckDefinition {
                schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
                check_id: "check-contract".to_string(),
                related_fingerprints: vec![failed],
                watched_paths: vec![PathBuf::from("src/contracts.rs")],
            },
            FindingCheckDefinition {
                schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
                check_id: "check-unrelated".to_string(),
                related_fingerprints: vec![],
                watched_paths: vec![PathBuf::from("src/unrelated.rs")],
            },
            FindingCheckDefinition {
                schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
                check_id: "check-api".to_string(),
                related_fingerprints: vec![],
                watched_paths: vec![PathBuf::from("src/api.rs")],
            },
        ],
    };

    assert_eq!(
        select_finding_reruns(&input).unwrap(),
        vec!["check-api".to_string(), "check-contract".to_string()]
    );
}

#[test]
fn false_positive_and_rerun_inputs_enforce_versions_paths_and_bounds() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let invalid_record = FindingFalsePositive {
        schema_version: FINDING_FALSE_POSITIVE_SCHEMA_VERSION,
        fingerprint: fingerprint.clone(),
        reason: "缺少适用条件".to_string(),
        applicability: BTreeMap::new(),
        recorded_run: "run-1".to_string(),
    };
    assert!(false_positive_still_applies(
        &invalid_record,
        &fingerprint,
        "缺少适用条件",
        &BTreeMap::new()
    )
    .is_err());

    let check = FindingCheckDefinition {
        schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
        check_id: "check-api".to_string(),
        related_fingerprints: vec![fingerprint.clone()],
        watched_paths: vec![PathBuf::from("src/api.rs")],
    };
    let unsafe_input = FindingRerunInput {
        schema_version: FINDING_RERUN_INPUT_SCHEMA_VERSION,
        failed_fingerprints: vec![fingerprint.clone()],
        modified_paths: vec![PathBuf::from("../src/api.rs")],
        checks: vec![check.clone()],
    };
    assert!(select_finding_reruns(&unsafe_input).is_err());

    let oversized = FindingRerunInput {
        schema_version: FINDING_RERUN_INPUT_SCHEMA_VERSION,
        failed_fingerprints: vec![],
        modified_paths: vec![],
        checks: vec![check; 501],
    };
    assert!(select_finding_reruns(&oversized).is_err());

    let wrong_version = FindingRerunInput {
        schema_version: 2,
        failed_fingerprints: vec![fingerprint],
        modified_paths: vec![],
        checks: vec![],
    };
    assert!(select_finding_reruns(&wrong_version).is_err());
}

#[test]
fn dag_persists_cross_run_facts_and_report_separates_plain_from_technical_identity() {
    let fingerprint = generate_finding_fingerprint(&input()).unwrap();
    let current = vec![snapshot(
        &fingerprint,
        "run-2",
        FindingLifecycle::New,
        "src/api.rs",
    )];
    let coverage = FindingComparisonCoverage {
        schema_version: FINDING_COMPARISON_COVERAGE_SCHEMA_VERSION,
        run_id: "run-2".to_string(),
        reviewed_scope: vec![PathBuf::from("src/api.rs")],
        coverage_complete: true,
        artifacts_complete: true,
    };
    let mut dag = TaskDAG::new("比较两次检查", vec![]);
    dag.record_finding_run_comparison(&[], &current, coverage)
        .unwrap();
    let false_positive = FindingFalsePositive {
        schema_version: FINDING_FALSE_POSITIVE_SCHEMA_VERSION,
        fingerprint: fingerprint.clone(),
        reason: "兼容模式不可达".to_string(),
        applicability: BTreeMap::from([("feature".to_string(), "legacy".to_string())]),
        recorded_run: "run-2".to_string(),
    };
    dag.record_finding_false_positive(false_positive.clone())
        .unwrap();
    dag.update_finding_rerun_plan(FindingRerunInput {
        schema_version: FINDING_RERUN_INPUT_SCHEMA_VERSION,
        failed_fingerprints: vec![fingerprint.clone()],
        modified_paths: vec![],
        checks: vec![FindingCheckDefinition {
            schema_version: FINDING_CHECK_DEFINITION_SCHEMA_VERSION,
            check_id: "check-api".to_string(),
            related_fingerprints: vec![fingerprint.clone()],
            watched_paths: vec![PathBuf::from("src/api.rs")],
        }],
    })
    .unwrap();

    let restored: TaskDAG = serde_json::from_value(serde_json::to_value(&dag).unwrap()).unwrap();
    assert_eq!(restored.finding_run_comparisons.len(), 1);
    assert_eq!(restored.finding_false_positives, vec![false_positive]);
    assert_eq!(restored.finding_rerun_plan, vec!["check-api"]);

    let report = ResultAggregator::build_report(&restored, &[]);
    let (plain, technical) = report.split_once("<details>").expect("technical details");
    assert!(plain.contains("与上次检查相比"), "{plain}");
    assert!(plain.contains("新增：1 项"), "{plain}");
    assert!(plain.contains("src/api.rs"), "{plain}");
    assert!(!plain.contains(&fingerprint), "{plain}");
    assert!(technical.contains(&fingerprint), "{technical}");
    assert!(technical.contains("当前运行首次出现"), "{technical}");
    assert!(technical.contains("check-api"), "{technical}");
}
